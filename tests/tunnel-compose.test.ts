import { describe, expect, it } from "bun:test";
import { parseDocument } from "yaml";
import {
  addExternalNetwork,
  ComposeConfigError,
  composeNetworks,
  deriveNetworkAlias,
  findServiceKeyByContainerName,
} from "@/lib/tunnels/compose";

// The real compose.yml of the `apps-tunnel` stack on 192.168.55.136.
const FIXTURE = await Bun.file(
  new URL("./fixtures/tunnel-compose.yml", import.meta.url)
).text();

describe("round-trip fidelity", () => {
  it("re-serializes an unmodified production compose file byte for byte", () => {
    const doc = parseDocument(FIXTURE);
    expect(doc.errors).toEqual([]);
    expect(
      doc.toString({ lineWidth: 0, indent: 2, flowCollectionPadding: false })
    ).toBe(FIXTURE);
  });
});

describe("findServiceKeyByContainerName", () => {
  it("matches on container_name, not on the service key", () => {
    expect(findServiceKeyByContainerName(FIXTURE, "apps-cloudflared")).toBe(
      "cloudflared"
    );
  });

  it("returns null when no service runs that container", () => {
    expect(
      findServiceKeyByContainerName(FIXTURE, "zitadel-cloudflared")
    ).toBeNull();
  });
});

describe("composeNetworks", () => {
  it("maps each alias to the real Docker network it names", () => {
    const networks = composeNetworks(FIXTURE);
    expect(networks.get("customer-portal")).toBe(
      "dplk-customer-portal_default"
    );
    expect(networks.get("dms")).toBe("dplk-dms_default");
    expect(networks.size).toBe(8);
  });

  it("falls back to the alias when no explicit name is given", () => {
    expect(
      composeNetworks("networks:\n  plain:\n    external: true\n").get("plain")
    ).toBe("plain");
  });
});

describe("deriveNetworkAlias", () => {
  it("strips the _default suffix compose appends", () => {
    expect(deriveNetworkAlias("hr-administration_default", [])).toBe(
      "hr-administration"
    );
  });

  it("suffixes on collision instead of overwriting an existing alias", () => {
    expect(deriveNetworkAlias("foo_default", ["foo"])).toBe("foo-2");
    expect(deriveNetworkAlias("foo_default", ["foo", "foo-2"])).toBe("foo-3");
  });
});

describe("addExternalNetwork", () => {
  const patched = addExternalNetwork(FIXTURE, {
    containerName: "apps-cloudflared",
    realName: "dapenmu-foo_default",
  });

  it("adds the alias to the service's network list", () => {
    expect(patched).toContain("      - dms\n      - dapenmu-foo\n");
  });

  it("declares the network external, never owned by this stack", () => {
    expect(patched).toContain(
      "  dapenmu-foo:\n    name: dapenmu-foo_default\n    external: true\n"
    );
  });

  it("leaves every pre-existing line untouched", () => {
    expect(
      patched
        .replace("      - dapenmu-foo\n", "")
        .replace(
          "  dapenmu-foo:\n    name: dapenmu-foo_default\n    external: true\n",
          ""
        )
    ).toBe(FIXTURE);
  });

  it("is idempotent — re-adding an already mapped network changes nothing", () => {
    expect(
      addExternalNetwork(FIXTURE, {
        containerName: "apps-cloudflared",
        realName: "dplk-dms_default",
      })
    ).toBe(FIXTURE);
  });

  it("attaches the service to a network already declared under an alias", () => {
    // Top-level declaration present, service not attached: only the service's
    // list should grow, and the existing declaration must not be duplicated.
    const source = FIXTURE.replace("      - dms\n", "");
    const next = addExternalNetwork(source, {
      containerName: "apps-cloudflared",
      realName: "dplk-dms_default",
    });
    expect(next).toBe(FIXTURE);
  });

  it("rejects a compose file where no service runs the tunnel container", () => {
    expect(() =>
      addExternalNetwork(FIXTURE, {
        containerName: "not-here",
        realName: "x_default",
      })
    ).toThrow(ComposeConfigError);
  });
});
