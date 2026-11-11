import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { pack } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  packageArtifactLayer,
  ReleasePackageError,
  releaseFileName,
} from "@/lib/releases/package";

type Entry = {
  name: string;
  body?: Buffer | string;
  type?: "file" | "directory" | "symlink" | "link";
  linkname?: string;
};

async function layerOf(entries: Entry[]): Promise<ReadableStream<Uint8Array>> {
  const tar = pack();
  for (const e of entries) {
    const header = {
      name: e.name,
      type: e.type ?? "file",
      linkname: e.linkname,
    };
    if (e.type && e.type !== "file") tar.entry(header);
    else tar.entry(header, e.body ?? "");
  }
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of tar) chunks.push(chunk as Buffer);
  const gz = await promisify(gzip)(Buffer.concat(chunks));
  return Readable.toWeb(
    Readable.from([gz])
  ) as unknown as ReadableStream<Uint8Array>;
}

// Lists zip entry names from the central directory (no zip library needed).
function zipNames(buf: Buffer): string[] {
  const names: string[] = [];
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString());
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "release-package-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("releaseFileName", () => {
  it("slugs the version", () => {
    expect(
      releaseFileName("legacy-core-backend", "TMLI 2026/11 #2", "jar")
    ).toBe("legacy-core-backend_TMLI-2026-11-2.jar");
  });
  it("uses zip for static and trims dashes", () => {
    expect(releaseFileName("web", " //v1.0.0// ", "static")).toBe(
      "web_v1.0.0.zip"
    );
  });
});

describe("packageArtifactLayer", () => {
  const jar = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));

  it("stores the single jar as is", async () => {
    const out = await packageArtifactLayer(
      await layerOf([
        { name: "bundle/", type: "directory" },
        { name: "bundle/artifact/", type: "directory" },
        { name: "bundle/artifact/x.jar", body: jar },
        { name: "bundle/other.txt", body: "ignored" },
      ]),
      "jar",
      dir,
      "x_1.jar"
    );
    expect(out.filePath).toBe(join(dir, "x_1.jar"));
    expect(out.sizeBytes).toBe(jar.length);
    expect(out.sha256).toBe(createHash("sha256").update(jar).digest("hex"));
    expect(await readFile(out.filePath)).toEqual(jar);
  });

  it("rejects two jars and leaves no file", async () => {
    await expect(
      packageArtifactLayer(
        await layerOf([
          { name: "bundle/artifact/a.jar", body: jar },
          { name: "bundle/artifact/b.jar", body: jar },
        ]),
        "jar",
        dir,
        "x.jar"
      )
    ).rejects.toThrow("artifact must contain exactly one jar");
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects no jar", async () => {
    await expect(
      packageArtifactLayer(
        await layerOf([{ name: "bundle/artifact/readme.txt", body: "x" }]),
        "jar",
        dir,
        "x.jar"
      )
    ).rejects.toBeInstanceOf(ReleasePackageError);
  });

  it("zips a static tree relative to bundle/artifact", async () => {
    const out = await packageArtifactLayer(
      await layerOf([
        { name: "bundle/artifact/js/", type: "directory" },
        { name: "bundle/artifact/index.html", body: "<html></html>" },
        { name: "bundle/artifact/js/app.js", body: "console.log(1)" },
      ]),
      "static",
      dir,
      "web_1.zip"
    );
    const buf = await readFile(out.filePath);
    expect(zipNames(buf).sort()).toEqual(["index.html", "js/app.js"]);
    expect(out.sizeBytes).toBe(buf.length);
    expect(out.sha256).toBe(createHash("sha256").update(buf).digest("hex"));
  });

  it("rejects static without index.html and leaves no file", async () => {
    await expect(
      packageArtifactLayer(
        await layerOf([{ name: "bundle/artifact/js/app.js", body: "x" }]),
        "static",
        dir,
        "web.zip"
      )
    ).rejects.toThrow("static artifact has no index.html");
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects an entry path with ..", async () => {
    await expect(
      packageArtifactLayer(
        await layerOf([{ name: "bundle/artifact/../x", body: "x" }]),
        "static",
        dir,
        "web.zip"
      )
    ).rejects.toThrow("unsafe path in artifact");
  });

  it("rejects an absolute entry path", async () => {
    await expect(
      packageArtifactLayer(
        await layerOf([{ name: "/etc/x", body: "x" }]),
        "jar",
        dir,
        "x.jar"
      )
    ).rejects.toThrow("unsafe path in artifact");
  });

  it("skips symlinks and hardlinks", async () => {
    const out = await packageArtifactLayer(
      await layerOf([
        { name: "bundle/artifact/index.html", body: "<html></html>" },
        {
          name: "bundle/artifact/evil",
          type: "symlink",
          linkname: "/etc/passwd",
        },
        {
          name: "bundle/artifact/hard",
          type: "link",
          linkname: "bundle/artifact/index.html",
        },
      ]),
      "static",
      dir,
      "web.zip"
    );
    expect(zipNames(await readFile(out.filePath))).toEqual(["index.html"]);
  });

  it("fails on a corrupt gzip", async () => {
    const bad = Readable.toWeb(Readable.from([Buffer.from("not gzip at all")]));
    await expect(
      packageArtifactLayer(
        bad as unknown as ReadableStream<Uint8Array>,
        "jar",
        dir,
        "x.jar"
      )
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});
