import { describe, expect, it } from "vitest";
import {
  buildPreflightCommand,
  parseHostPublishedPorts,
  parsePreflight,
} from "@/lib/provisioning/preflight";

const REGISTRY = "192.168.10.113:5000";

const OUTPUT = [
  "@@docker",
  "29.0.1",
  "@@compose",
  "5.1.4",
  "@@podman",
  "@@registry",
  "https 200",
  "@@df",
  "Filesystem        1-blocks        Used   Available Capacity Mounted on",
  "/dev/sda2     107374182400 32212254720 75161927680      31% /",
  "/dev/sdb1     214748364800 21474836480 193273528320      10% /deployments",
  "@@cloudflared",
  "active",
  "@@ps",
  "dplk-postgres\tpostgres:18.6\t5432/tcp",
  "hris-db\tpostgres:18.6\t5432/tcp",
  "opsdeck-db\tpostgres:18-alpine\t0.0.0.0:5433->5432/tcp",
  "tunnel\tcloudflare/cloudflared:2026.8.2\t",
  "registry\tregistry:2\t0.0.0.0:5000->5000/tcp",
  "hris\tlocalhost/hris:1\t0.0.0.0:8091->3000/tcp",
  "@@ss",
  "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*",
  "LISTEN 0 511 0.0.0.0:80 0.0.0.0:*",
  "LISTEN 0 4096 *:5000 *:*",
  "LISTEN 0 4096 [::]:8091 [::]:*",
  "LISTEN 0 128 [::]:22 [::]:*",
  "",
].join("\n");

describe("parsePreflight", () => {
  it("reads a .113-like host", () => {
    expect(parsePreflight(OUTPUT, REGISTRY)).toEqual({
      runtime: { docker: "29.0.1", compose: "5.1.4", podman: null },
      registry: { url: `https://${REGISTRY}/v2/`, ok: true, status: 200 },
      disk: [
        {
          mount: "/",
          freeBytes: 75161927680,
          totalBytes: 107374182400,
        },
        {
          mount: "/deployments",
          freeBytes: 193273528320,
          totalBytes: 214748364800,
        },
      ],
      cloudflared: { systemd: true, containers: ["tunnel"] },
      listeningPorts: [22, 80, 5000, 8091],
      // Host-side ports; the bare "5432/tcp" exposures publish nothing.
      publishedPorts: [5000, 5433, 8091],
      postgresCandidates: [
        { container: "dplk-postgres", image: "postgres:18.6" },
        { container: "hris-db", image: "postgres:18.6" },
        { container: "opsdeck-db", image: "postgres:18-alpine" },
      ],
    });
  });

  it("drops duplicate df mounts", () => {
    const out = [
      "@@df",
      "Filesystem 1-blocks Used Available Capacity Mounted on",
      "/dev/sda2 100 10 90 10% /",
      "/dev/sda2 100 10 90 10% /",
    ].join("\n");
    expect(parsePreflight(out, null).disk).toHaveLength(1);
  });

  it("tolerates missing tools", () => {
    const out =
      "@@docker\n@@compose\n@@podman\n@@df\n@@cloudflared\n@@ps\n@@ss\n";
    expect(parsePreflight(out, null)).toEqual({
      runtime: { docker: null, compose: null, podman: null },
      registry: null,
      disk: [],
      cloudflared: { systemd: false, containers: [] },
      listeningPorts: [],
      publishedPorts: [],
      postgresCandidates: [],
    });
    expect(() => parsePreflight("", REGISTRY)).not.toThrow();
  });

  it("matches postgis and registry-prefixed postgres images only", () => {
    const out = [
      "@@ps",
      "a\tpostgis/postgis:16\t",
      "b\treg.local:5000/library/postgres@sha256:abc\t",
      "c\tpgbouncer:1\t",
      "d\tmy-postgres-exporter:1\t",
    ].join("\n");
    expect(
      parsePreflight(out, null).postgresCandidates.map((c) => c.container)
    ).toEqual(["a", "b"]);
  });
});

describe("buildPreflightCommand", () => {
  it("probes the registry with a quoted URL", () => {
    const cmd = buildPreflightCommand("registry.example:5000");
    expect(cmd).toContain("'https://registry.example:5000/v2/'");
    expect(cmd).toContain("@@registry");
  });

  it("skips curl without a registry", () => {
    expect(buildPreflightCommand(null)).not.toContain("curl");
  });

  it("fences every probe and tolerates missing tools", () => {
    const cmd = buildPreflightCommand(null);
    for (const m of [
      "docker",
      "compose",
      "podman",
      "df",
      "cloudflared",
      "ps",
      "ss",
    ]) {
      expect(cmd).toContain(`@@${m}`);
    }
    expect(cmd).toContain("ss -Htln");
    expect(cmd).toContain("|| true");
  });
});

describe("registry fallback", () => {
  it("falls back to http when https gives no answer", () => {
    const out = "@@registry\nhttps 000\nhttp 200\n";
    expect(parsePreflight(out, REGISTRY).registry).toEqual({
      url: `http://${REGISTRY}/v2/`,
      ok: true,
      status: 200,
    });
  });

  it("reports the https URL when neither answers", () => {
    const out = "@@registry\nhttps 000\nhttp 000\n";
    expect(parsePreflight(out, REGISTRY).registry).toEqual({
      url: `https://${REGISTRY}/v2/`,
      ok: false,
      status: null,
    });
  });

  it("the script retries over http only on 000", () => {
    const cmd = buildPreflightCommand(REGISTRY);
    expect(cmd).toContain(`'https://${REGISTRY}/v2/'`);
    expect(cmd).toContain(`'http://${REGISTRY}/v2/'`);
    expect(cmd.indexOf("https://")).toBeLessThan(cmd.indexOf("'http://"));
  });
});

describe("parseHostPublishedPorts", () => {
  it("takes the host port before the arrow", () => {
    expect(parseHostPublishedPorts("127.0.0.1:8091->80/tcp")).toEqual([8091]);
    expect(parseHostPublishedPorts("0.0.0.0:8091->3000/tcp")).toEqual([8091]);
  });

  it("handles IPv6 prefixes and dedupes", () => {
    expect(
      parseHostPublishedPorts(
        "0.0.0.0:5000->5000/tcp, [::]:5000->5000/tcp, :::6000->6000/tcp"
      )
    ).toEqual([5000, 6000]);
  });

  it("expands ranges", () => {
    expect(parseHostPublishedPorts("0.0.0.0:8100-8102->8100-8102/tcp")).toEqual(
      [8100, 8101, 8102]
    );
  });

  it("ignores bare exposures", () => {
    expect(parseHostPublishedPorts("3000/tcp, 5432/tcp")).toEqual([]);
    expect(parseHostPublishedPorts("")).toEqual([]);
  });
});
