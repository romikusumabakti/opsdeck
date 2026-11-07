import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { dockerNetworkSchema } from "@/lib/setup/network";
import {
  COMPOSE_OVERLAY_FILE,
  renderComposeOverlay,
} from "@/lib/variables/compose-overlay";

describe("renderComposeOverlay", () => {
  it("joins the services to the external network next to default", () => {
    const yaml = renderComposeOverlay(["hris-backend"], "shared-postgres");
    expect(COMPOSE_OVERLAY_FILE).toBe("compose.opsdeck.yaml");
    expect(yaml.split("\n")[0]).toMatch(
      /^# Written by the DSS Panel; do not edit/
    );
    expect(parse(yaml)).toEqual({
      services: {
        "hris-backend": { networks: ["default", "shared-postgres"] },
      },
      networks: { "shared-postgres": { external: true } },
    });
  });

  it("is deterministic and keeps the given service order", () => {
    const a = renderComposeOverlay(["worker", "api"], "db-net");
    expect(renderComposeOverlay(["worker", "api"], "db-net")).toBe(a);
    expect(Object.keys(parse(a).services)).toEqual(["worker", "api"]);
  });

  // Names YAML would read as a bool, null or number must stay strings.
  it.each([
    "true",
    "false",
    "null",
    "no",
    "yes",
    "on",
    "off",
    "123",
    "1e3",
    "0x1f",
    "1.5",
  ])("keeps %s a string as a service and as a network name", (name) => {
    const parsed = parse(renderComposeOverlay([name], name), {
      schema: "core",
    });
    expect(Object.keys(parsed.services)).toEqual([name]);
    expect(parsed.services[name].networks).toEqual(["default", name]);
    expect(Object.keys(parsed.networks)).toEqual([name]);
    // YAML 1.1 readers (bool words) must see strings too.
    const legacy = parse(renderComposeOverlay([name], name), {
      schema: "yaml-1.1",
    });
    expect(legacy.services[name].networks).toEqual(["default", name]);
  });

  it("refuses a service name with a quote or other unsafe character", () => {
    for (const bad of ['a"b', "a'b", "a b", "A", "a\nb", "a: b", ""]) {
      expect(() => renderComposeOverlay([bad], "net"), bad).toThrow();
    }
  });

  it("refuses invalid or reserved network names, no services and duplicates", () => {
    for (const bad of ['n"t', "a b", "", "default", "bridge", "host", "none"]) {
      expect(() => renderComposeOverlay(["api"], bad), bad).toThrow();
    }
    expect(() => renderComposeOverlay([], "net")).toThrow();
    expect(() => renderComposeOverlay(["api", "api"], "net")).toThrow();
  });
});

describe("dockerNetworkSchema", () => {
  it("rejects default and Docker's built-in networks", () => {
    for (const name of ["default", "bridge", "host", "none"]) {
      expect(dockerNetworkSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it("still accepts ordinary names, including ones that merely start with them", () => {
    for (const name of [
      "shared-postgres",
      "default-net",
      "bridge2",
      "Net_1.a",
    ]) {
      expect(dockerNetworkSchema.safeParse(name).success, name).toBe(true);
    }
  });
});

// Review Focus 3: what Compose makes of base + overlay. Needs a compose
// binary; skipped (with the reason) where there is none.
function composeCommand(): string[] | null {
  const candidates = [["docker-compose"], ["docker", "compose"]];
  for (const cmd of candidates) {
    const probe = spawnSync(cmd[0] as string, [...cmd.slice(1), "version"], {
      encoding: "utf8",
    });
    if (probe.status === 0) return cmd;
  }
  return null;
}

const compose = composeCommand();

describe.skipIf(!compose)(
  "compose merge (skipped: no docker-compose or `docker compose` on PATH)",
  () => {
    it("keeps the service's own network and adds default and the shared one", () => {
      const dir = mkdtempSync(join(tmpdir(), "compose-overlay-"));
      try {
        writeFileSync(
          join(dir, "compose.yaml"),
          "services:\n  hris-backend:\n    image: busybox\n    networks: [internal]\nnetworks:\n  internal: {}\n"
        );
        writeFileSync(
          join(dir, COMPOSE_OVERLAY_FILE),
          renderComposeOverlay(["hris-backend"], "shared-postgres")
        );
        const [bin, ...pre] = compose as string[];
        const result = spawnSync(
          bin as string,
          [
            ...pre,
            "-f",
            join(dir, "compose.yaml"),
            "-f",
            join(dir, COMPOSE_OVERLAY_FILE),
            "config",
            "--format",
            "json",
          ],
          {
            encoding: "utf8",
            env: { ...process.env, PODMAN_COMPOSE_WARNING_LOGS: "false" },
          }
        );
        expect(result.status, result.stderr).toBe(0);
        const config = JSON.parse(
          result.stdout.slice(result.stdout.indexOf("{"))
        );
        expect(
          Object.keys(config.services["hris-backend"].networks).sort()
        ).toEqual(["default", "internal", "shared-postgres"]);
        expect(config.networks["shared-postgres"].external).toBe(true);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  }
);
