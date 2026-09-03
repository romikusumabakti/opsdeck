import { describe, expect, it } from "bun:test";
import {
  cnameTarget,
  describeCloudflareErrors,
} from "@/lib/tunnels/cloudflare";
import {
  composeFilePath,
  configFilePath,
  parsePublishedPorts,
} from "@/lib/tunnels/remote";

describe("configFilePath", () => {
  it("joins the stack directory with the config path", () => {
    expect(
      configFilePath({
        stackDir: "/opt/stacks/apps-tunnel",
        configPath: "cloudflared/config.yml",
      })
    ).toBe("/opt/stacks/apps-tunnel/cloudflared/config.yml");
  });

  it("tolerates a trailing slash on the stack directory", () => {
    expect(
      configFilePath({
        stackDir: "/opt/stacks/apps-tunnel/",
        configPath: "cloudflared/config.yml",
      })
    ).toBe("/opt/stacks/apps-tunnel/cloudflared/config.yml");
  });
});

describe("composeFilePath", () => {
  it("resolves the stack's compose file", () => {
    expect(composeFilePath("/opt/stacks/apps-tunnel")).toBe(
      "/opt/stacks/apps-tunnel/compose.yml"
    );
  });
});

describe("parsePublishedPorts", () => {
  // The Ports column mixes both forms, and only the container-side port is
  // usable as an ingress origin — the host-side one is exactly what the tunnel
  // exists to stop depending on.
  it("takes the container-side port of a published mapping", () => {
    expect(parsePublishedPorts("0.0.0.0:8080->80/tcp")).toEqual([80]);
  });

  it("reads a bare exposure", () => {
    expect(parsePublishedPorts("3000/tcp")).toEqual([3000]);
  });

  it("handles several mappings and de-duplicates", () => {
    expect(
      parsePublishedPorts("0.0.0.0:8080->80/tcp, :::8080->80/tcp, 3000/tcp")
    ).toEqual([80, 3000]);
  });

  it("returns nothing for a container that publishes nothing", () => {
    expect(parsePublishedPorts("")).toEqual([]);
  });
});

describe("cnameTarget", () => {
  it("builds the internal hostname a tunnel route CNAMEs to", () => {
    expect(cnameTarget("421f7083-06b9-4e64-98ec-d64df7e14e41")).toBe(
      "421f7083-06b9-4e64-98ec-d64df7e14e41.cfargotunnel.com"
    );
  });
});

describe("describeCloudflareErrors", () => {
  it("keeps the code, which is how the operational cases are told apart", () => {
    expect(
      describeCloudflareErrors([
        { code: 10000, message: "Authentication error" },
      ])
    ).toBe("Authentication error (code 10000)");
  });

  it("joins several errors", () => {
    expect(
      describeCloudflareErrors([
        { code: 81053, message: "An A, AAAA, or CNAME record already exists" },
        { message: "second" },
      ])
    ).toBe("An A, AAAA, or CNAME record already exists (code 81053); second");
  });

  it("says something useful when Cloudflare returns no error detail", () => {
    expect(describeCloudflareErrors([])).toBe(
      "Cloudflare returned an unsuccessful response"
    );
  });
});
