import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assetChecksums,
  buildReleaseManifest,
  parseImageLines,
} from "@/scripts/release-manifest";

// release.json is read on the host by update.sh with sed/awk (no JSON
// parser): it must be one compact line without backslashes, and every image
// pinned by digest in the form update.sh's IMAGE_RE accepts.

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const IMAGES = {
  app: `ghcr.io/romikusumabakti/opsdeck:1.2.0@${digest("a")}`,
  postgres: `docker.io/library/postgres:18@${digest("b")}`,
  valkey: `docker.io/valkey/valkey:9-alpine@${digest("c")}`,
  garage: `docker.io/dxflrs/garage:v2.3.0@${digest("d")}`,
  imgproxy: `ghcr.io/imgproxy/imgproxy:v4.0.6@${digest("e")}`,
  caddy: `docker.io/library/caddy:2-alpine@${digest("f")}`,
};

const ASSETS = {
  "compose.yaml": "1".repeat(64),
  "update.sh": "2".repeat(64),
};

// update.sh's IMAGE_RE, anchored.
const UPDATE_SH_IMAGE_RE =
  /^[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;

describe("buildReleaseManifest", () => {
  it("builds the exact one-line JSON from its inputs", () => {
    const text = buildReleaseManifest({
      version: "1.2.0",
      minFrom: "0.1.0",
      images: IMAGES,
      assets: ASSETS,
    });
    expect(text).toBe(
      `{"version":"1.2.0","minFrom":"0.1.0","images":{"app":"${IMAGES.app}","postgres":"${IMAGES.postgres}","valkey":"${IMAGES.valkey}","garage":"${IMAGES.garage}","imgproxy":"${IMAGES.imgproxy}","caddy":"${IMAGES.caddy}"},"assets":{"compose.yaml":"${ASSETS["compose.yaml"]}","update.sh":"${ASSETS["update.sh"]}"},"notesUrl":"https://github.com/romikusumabakti/opsdeck/releases/tag/v1.2.0"}`
    );
    expect(text).not.toContain("\n");
    expect(text).not.toContain("\\");
    for (const ref of Object.values(IMAGES)) {
      expect(ref).toMatch(UPDATE_SH_IMAGE_RE);
    }
  });

  it("accepts a beta version", () => {
    const text = buildReleaseManifest({
      version: "1.3.0-beta.2",
      minFrom: "0.1.0",
      images: {
        ...IMAGES,
        app: `ghcr.io/romikusumabakti/opsdeck:1.3.0-beta.2@${digest("a")}`,
      },
      assets: ASSETS,
    });
    expect(JSON.parse(text).notesUrl).toBe(
      "https://github.com/romikusumabakti/opsdeck/releases/tag/v1.3.0-beta.2"
    );
  });

  it.each([
    ["a tag without a digest", "docker.io/library/postgres:18"],
    ["a short digest", "docker.io/library/postgres:18@sha256:abc"],
    ["an upper-case digest", `postgres:18@sha256:${"A".repeat(64)}`],
    ["a moving latest tag", `postgres:latest@${digest("b")}`],
    ["an upper-case name", `Postgres:18@${digest("b")}`],
  ])("rejects %s", (_label, ref) => {
    expect(() =>
      buildReleaseManifest({
        version: "1.2.0",
        minFrom: "0.1.0",
        images: { ...IMAGES, postgres: ref },
        assets: ASSETS,
      })
    ).toThrow(/postgres/);
  });

  it("rejects a missing image key", () => {
    const { caddy: _caddy, ...rest } = IMAGES;
    expect(() =>
      buildReleaseManifest({
        version: "1.2.0",
        minFrom: "0.1.0",
        images: rest as typeof IMAGES,
        assets: ASSETS,
      })
    ).toThrow(/caddy/);
  });

  it.each([
    ["a leading v", "v1.2.0", "0.1.0"],
    ["a release candidate", "1.2.0-rc.1", "0.1.0"],
    ["a bad minFrom", "1.2.0", "0.1"],
    ["a minFrom above the version", "1.2.0", "1.3.0"],
  ])("rejects %s", (_label, version, minFrom) => {
    expect(() =>
      buildReleaseManifest({ version, minFrom, images: IMAGES, assets: ASSETS })
    ).toThrow();
  });

  it.each([
    ["a missing asset", { "compose.yaml": ASSETS["compose.yaml"] }],
    ["a short sha256", { ...ASSETS, "update.sh": "abc" }],
    ["an upper-case sha256", { ...ASSETS, "update.sh": "A".repeat(64) }],
  ])("rejects %s", (_label, assets) => {
    expect(() =>
      buildReleaseManifest({
        version: "1.2.0",
        minFrom: "0.1.0",
        images: IMAGES,
        assets: assets as typeof ASSETS,
      })
    ).toThrow(/asset/);
  });

  it("rejects an app image of another version", () => {
    expect(() =>
      buildReleaseManifest({
        version: "1.2.1",
        minFrom: "0.1.0",
        images: IMAGES,
        assets: ASSETS,
      })
    ).toThrow(/app/);
  });
});

describe("parseImageLines", () => {
  it("reads key=ref lines, skipping blanks and comments", () => {
    expect(
      parseImageLines(
        `# resolved\npostgres=${IMAGES.postgres}\n\ncaddy=${IMAGES.caddy}\n`
      )
    ).toEqual({ postgres: IMAGES.postgres, caddy: IMAGES.caddy });
  });

  it("rejects an unknown key and a malformed line", () => {
    expect(() => parseImageLines(`terminal=${IMAGES.app}`)).toThrow(/terminal/);
    expect(() => parseImageLines("postgres")).toThrow();
  });
});

describe("bun scripts/release-manifest.ts", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true });
  });

  it("writes release.json from the flags and files", () => {
    const root = mkdtempSync(join(tmpdir(), "release-manifest-"));
    roots.push(root);
    const { app, ...base } = IMAGES;
    writeFileSync(
      join(root, "images.env"),
      Object.entries(base)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")
    );
    writeFileSync(join(root, "min-from.txt"), "0.1.0\n");
    const assets = join(root, "assets");
    mkdirSync(assets);
    writeFileSync(join(assets, "compose.yaml"), "services: {}\n");
    writeFileSync(join(assets, "update.sh"), "#!/bin/sh\n");
    const out = join(root, "release.json");
    const result = spawnSync(
      "bun",
      [
        "scripts/release-manifest.ts",
        "--version",
        "1.2.0",
        "--app",
        app,
        "--images",
        join(root, "images.env"),
        "--min-from",
        join(root, "min-from.txt"),
        "--assets",
        assets,
        "--out",
        out,
      ],
      { encoding: "utf8" }
    );
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(out, "utf8");
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    expect(text).toBe(
      `${buildReleaseManifest({
        version: "1.2.0",
        minFrom: "0.1.0",
        images: IMAGES,
        assets: {
          "compose.yaml": sha("services: {}\n"),
          "update.sh": sha("#!/bin/sh\n"),
        },
      })}\n`
    );
  });

  it("checksums the shipped compose.yaml and update.sh", () => {
    const sums = assetChecksums("ops/install");
    for (const name of ["compose.yaml", "update.sh"] as const) {
      expect(sums[name]).toBe(
        createHash("sha256")
          .update(readFileSync(`ops/install/${name}`))
          .digest("hex")
      );
    }
  });

  it("exits 1 for a non-digest ref", () => {
    const root = mkdtempSync(join(tmpdir(), "release-manifest-"));
    roots.push(root);
    writeFileSync(join(root, "images.env"), "postgres=postgres:18\n");
    writeFileSync(join(root, "min-from.txt"), "0.1.0\n");
    const result = spawnSync(
      "bun",
      [
        "scripts/release-manifest.ts",
        "--version",
        "1.2.0",
        "--app",
        IMAGES.app,
        "--images",
        join(root, "images.env"),
        "--min-from",
        join(root, "min-from.txt"),
        "--assets",
        "ops/install",
        "--out",
        join(root, "release.json"),
      ],
      { encoding: "utf8" }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/postgres/);
  });

  it("ships minFrom 0.1.0", () => {
    expect(readFileSync("release/min-from.txt", "utf8").trim()).toBe("0.1.0");
  });
});
