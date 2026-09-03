import { describe, expect, it } from "bun:test";
import { parseDocument } from "yaml";
import {
  addRoute,
  assertCatchAllLast,
  formatOrigin,
  IngressConfigError,
  parseIngress,
  parseOrigin,
  parseTunnelId,
  removeRoute,
} from "@/lib/tunnels/ingress";

// The real config.yml of the `dss-apps-136` tunnel on 192.168.55.136 as of
// 2026-09-03, comments and all. Editing an operator-written file is the whole
// risk of this feature, so the fixture is the genuine article rather than a
// tidied sample. Pinned deliberately: the live file keeps growing, and this
// test is about the shapes an operator writes, not about today's route list.
const FIXTURE = await Bun.file(
  new URL("./fixtures/tunnel-config.yml", import.meta.url)
).text();

describe("round-trip fidelity", () => {
  // The load-bearing test for the whole approach. If parsing and re-serializing
  // an untouched document is not byte-identical, then every edit also silently
  // reformats the parts of the file nobody asked to change — and the file stops
  // being something an operator can read and trust. Should this ever fail,
  // ingress.ts must switch from the Document API to anchored text splicing.
  it("re-serializes an unmodified production config byte for byte", () => {
    const doc = parseDocument(FIXTURE);
    expect(doc.errors).toEqual([]);
    expect(
      doc.toString({ lineWidth: 0, indent: 2, flowCollectionPadding: false })
    ).toBe(FIXTURE);
  });
});

describe("parseIngress", () => {
  it("lists the routes of the production config in file order", () => {
    const routes = parseIngress(FIXTURE);
    expect(routes.map((r) => r.hostname)).toEqual([
      "dapenmu-portal.dssconsulting.id",
      "dapenmu-accounting.dssconsulting.id",
      "dapenmu-cms.dssconsulting.id",
      "dapenmu-hrd.dssconsulting.id",
      "dapenmu-wallboard.dssconsulting.id",
      "dapenmu-wallboard-demo.dssconsulting.id",
      "dapenmu-wallboard-admin.dssconsulting.id",
      "dapenmu-middleware.dssconsulting.id",
      "dapenmu-dms.dssconsulting.id",
    ]);
  });

  it("excludes the catch-all, which is structural rather than a route", () => {
    expect(
      parseIngress(FIXTURE).some((r) => r.service.startsWith("http_status:"))
    ).toBe(false);
  });

  it("splits each origin into host and port", () => {
    const middleware = parseIngress(FIXTURE).find((r) =>
      r.hostname.startsWith("dapenmu-middleware")
    );
    expect(middleware?.origin).toEqual({
      scheme: "http",
      host: "dplk-middleware",
      port: 3000,
    });
  });

  it("rejects a file with no ingress list", () => {
    expect(() => parseIngress("tunnel: abc\n")).toThrow(IngressConfigError);
  });
});

describe("parseTunnelId", () => {
  it("reads the tunnel UUID the CNAME must point at", () => {
    expect(parseTunnelId(FIXTURE)).toBe("421f7083-06b9-4e64-98ec-d64df7e14e41");
  });

  it("returns null when the key is absent", () => {
    expect(parseTunnelId("ingress: []\n")).toBeNull();
  });
});

describe("parseOrigin", () => {
  it("defaults the port to null when the origin omits one", () => {
    expect(parseOrigin("http://dms-caddy")).toEqual({
      scheme: "http",
      host: "dms-caddy",
      port: null,
    });
  });

  it("returns null for service forms that are not network origins", () => {
    expect(parseOrigin("http_status:404")).toBeNull();
    expect(parseOrigin("hello_world")).toBeNull();
    expect(parseOrigin("unix:/var/run/app.sock")).toBeNull();
  });
});

describe("formatOrigin", () => {
  it("addresses an origin by container name and internal port", () => {
    expect(formatOrigin("hr-admin-frontend", 80)).toBe(
      "http://hr-admin-frontend:80"
    );
  });
});

describe("addRoute", () => {
  const added = addRoute(FIXTURE, {
    hostname: "dapenmu-foo.dssconsulting.id",
    service: "http://dapenmu-foo-web:8080",
  });

  it("inserts the route before the catch-all", () => {
    const hostnames = parseIngress(added).map((r) => r.hostname);
    expect(hostnames.at(-1)).toBe("dapenmu-foo.dssconsulting.id");
    expect(hostnames).toHaveLength(10);
    expect(() => assertCatchAllLast(added)).not.toThrow();
  });

  it("writes the origin and the default connect timeout", () => {
    expect(added).toContain("  - hostname: dapenmu-foo.dssconsulting.id\n");
    expect(added).toContain("    service: http://dapenmu-foo-web:8080\n");
    expect(added).toContain("      connectTimeout: 30s\n");
  });

  it("leaves every pre-existing line untouched", () => {
    // The added block is the ONLY difference: dropping it must reproduce the
    // original file exactly, comments and blank lines included.
    expect(
      added.replace(
        "\n  - hostname: dapenmu-foo.dssconsulting.id\n    service: http://dapenmu-foo-web:8080\n    originRequest:\n      connectTimeout: 30s\n",
        ""
      )
    ).toBe(FIXTURE);
  });

  it("keeps the comment that documents the catch-all attached to it", () => {
    expect(added).toContain(
      "  # Anything that reaches this tunnel with an unexpected Host is not ours.\n  - service: http_status:404"
    );
  });

  it("refuses to silently re-point a hostname that is already routed", () => {
    expect(() =>
      addRoute(FIXTURE, {
        hostname: "dapenmu-portal.dssconsulting.id",
        service: "http://somewhere-else:80",
      })
    ).toThrow(/already routed/);
  });

  it("refuses a config whose catch-all is not last", () => {
    const broken =
      "ingress:\n  - service: http_status:404\n  - hostname: a.example.com\n    service: http://a:80\n";
    expect(() =>
      addRoute(broken, { hostname: "b.example.com", service: "http://b:80" })
    ).toThrow(IngressConfigError);
  });
});

describe("removeRoute", () => {
  it("removes the entry and leaves the rest of the file byte-identical", () => {
    const hostname = "dapenmu-foo.dssconsulting.id";
    const added = addRoute(FIXTURE, {
      hostname,
      service: "http://dapenmu-foo-web:8080",
    });
    expect(removeRoute(added, hostname)).toBe(FIXTURE);
  });

  it("takes the comment written above an entry with it", () => {
    // The dms entry carries a two-line comment explaining why the tunnel talks
    // to plaintext :80. Removing the route must not orphan that comment onto
    // the catch-all below it.
    const next = removeRoute(FIXTURE, "dapenmu-dms.dssconsulting.id");
    expect(next).not.toContain("dms-caddy also listens on 443");
    expect(next).not.toContain("dapenmu-dms");
    expect(() => assertCatchAllLast(next)).not.toThrow();
  });

  it("keeps the first entry flush against the header when it removes it", () => {
    const next = removeRoute(FIXTURE, "dapenmu-portal.dssconsulting.id");
    expect(next).toContain(
      "ingress:\n  - hostname: dapenmu-accounting.dssconsulting.id"
    );
  });

  it("rejects a hostname this tunnel does not route", () => {
    expect(() => removeRoute(FIXTURE, "nope.dssconsulting.id")).toThrow(
      /not routed/
    );
  });
});

describe("assertCatchAllLast", () => {
  it("accepts the production config", () => {
    expect(() => assertCatchAllLast(FIXTURE)).not.toThrow();
  });

  it("rejects an empty ingress list", () => {
    expect(() => assertCatchAllLast("ingress: []\n")).toThrow(
      /expected a catch-all/
    );
  });

  it("rejects an ingress whose last rule still has a hostname", () => {
    expect(() =>
      assertCatchAllLast(
        "ingress:\n  - hostname: a.example.com\n    service: http://a:80\n"
      )
    ).toThrow(/final rule to be a catch-all/);
  });

  it("rejects a catch-all buried in the middle, which swallows what follows", () => {
    expect(() =>
      assertCatchAllLast(
        "ingress:\n  - service: http_status:404\n  - hostname: a.example.com\n    service: http://a:80\n  - service: http_status:404\n"
      )
    ).toThrow(/swallow every request/);
  });
});
