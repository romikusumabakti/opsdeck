import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  pipeline as pipelineCb,
  Readable,
  Transform,
  type Writable,
} from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import { ZipFile } from "yazl";

/**
 * Turns a registry artifact layer (gzip tar, entries under `bundle/artifact/`)
 * into the release file: the single jar as is, or the static tree as one zip.
 * Streams end to end; the layer and the output are never held in memory.
 */

const ARTIFACT_PREFIX = "bundle/artifact/";

export class ReleasePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleasePackageError";
  }
}

/** `<componentKey>_<versionSlug>.<jar|zip>` */
export function releaseFileName(
  componentKey: string,
  version: string,
  kind: "jar" | "static"
): string {
  const slug = version
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${componentKey}_${slug}.${kind === "jar" ? "jar" : "zip"}`;
}

function isUnsafe(name: string): boolean {
  return name.startsWith("/") || name.split("/").includes("..");
}

function hashing() {
  const hash = createHash("sha256");
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  return {
    tap,
    result: () => ({ sizeBytes: size, sha256: hash.digest("hex") }),
  };
}

export async function packageArtifactLayer(
  layer: ReadableStream<Uint8Array>,
  kind: "jar" | "static",
  outDir: string,
  fileName: string
): Promise<{ filePath: string; sizeBytes: number; sha256: string }> {
  if (
    basename(fileName) !== fileName ||
    fileName === "." ||
    fileName === ".."
  ) {
    throw new ReleasePackageError("invalid release file name");
  }
  const filePath = join(outDir, fileName);
  // Written under a unique temp name (O_EXCL, so a pre-existing file or symlink
  // is never followed or truncated) and renamed onto the final name only once
  // complete: a failed run never touches an existing release file.
  const tempPath = join(outDir, `.${fileName}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(tempPath, "wx");
  } catch (error) {
    // Nothing will read the layer; release the registry connection.
    await layer.cancel().catch(() => {});
    throw error;
  }
  const out = handle.createWriteStream();
  try {
    const result = await (kind === "jar"
      ? packageJar(layer, out)
      : packageStatic(layer, out));
    await rename(tempPath, filePath);
    return { filePath, ...result };
  } catch (error) {
    out.destroy();
    await rm(tempPath, { force: true });
    throw error;
  }
}

type ArtifactEntry = { path: string; stream: Readable };

// Tar entries must be consumed before the next one is yielded. Anything that is
// not a regular file (directories, symlinks, hardlinks, devices, whiteouts) is
// skipped: links are never followed or written. Unsafe paths are refused for
// every entry, whatever its type.
async function* artifactFiles(
  layer: ReadableStream<Uint8Array>
): AsyncGenerator<ArtifactEntry> {
  const tar = extract();
  // The callback form destroys every stage with the error, so a corrupt gzip
  // or a failed registry read surfaces from the iteration below.
  pipelineCb(Readable.fromWeb(layer as never), createGunzip(), tar, () => {});
  for await (const entry of tar) {
    const { name, type } = entry.header;
    if (isUnsafe(name)) {
      entry.resume();
      throw new ReleasePackageError("unsafe path in artifact");
    }
    if (type !== "file" || !name.startsWith(ARTIFACT_PREFIX)) {
      entry.resume();
      continue;
    }
    yield {
      path: name.slice(ARTIFACT_PREFIX.length),
      stream: entry as unknown as Readable,
    };
    // The consumer must have drained the entry; make sure the next one flows.
    entry.resume();
    await finished(entry as unknown as Readable);
  }
}

async function packageJar(layer: ReadableStream<Uint8Array>, out: Writable) {
  const { tap, result } = hashing();
  let found = false;
  for await (const { path, stream } of artifactFiles(layer)) {
    if (!path.endsWith(".jar")) {
      stream.resume();
      continue;
    }
    if (found) {
      stream.resume();
      throw new ReleasePackageError("artifact must contain exactly one jar");
    }
    found = true;
    // Awaiting here keeps the entry consumed before the iterator moves on.
    await pipeline(stream, tap, out);
  }
  if (!found)
    throw new ReleasePackageError("artifact must contain exactly one jar");
  return result();
}

async function packageStatic(layer: ReadableStream<Uint8Array>, out: Writable) {
  const { tap, result } = hashing();
  const zip = new ZipFile();
  const output = pipeline(zip.outputStream as Readable, tap, out);
  // Handled below through the race; this only prevents an unhandled rejection
  // while the loop is not currently awaiting it.
  output.catch(() => {});
  let hasIndex = false;
  try {
    for await (const { path, stream } of artifactFiles(layer)) {
      if (path === "index.html") hasIndex = true;
      // yazl pumps entries in order, so this entry is read while the tar
      // iterator waits for it to end. If the output write fails, yazl's pipe
      // stalls and the entry never ends, so race against the output.
      zip.addReadStream(stream, path);
      await Promise.race([finished(stream), output]);
    }
    if (!hasIndex)
      throw new ReleasePackageError("static artifact has no index.html");
  } catch (error) {
    (zip.outputStream as Readable).destroy();
    await output.catch(() => {});
    throw error;
  }
  zip.end();
  await output;
  return result();
}
