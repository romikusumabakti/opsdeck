import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import { fileVerdict, isWithheldPath } from "@/lib/assistant/secret-filter";
import type { AssistantSource } from "@/lib/assistant/sources";
import {
  type BitbucketAuth,
  downloadArchive,
  getBranchHead,
} from "@/lib/ci/forges/bitbucket";
import { getForgeCredentials } from "@/server/services/ci-connections";

const DEFAULT_ROOT = "/var/lib/menara/assistant";
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const RETENTION_DAYS = 14;
const MAX_TOTAL_BYTES = 5 * 1024 ** 3;
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const READY = ".ready";
const USED = ".used";
const WITHHELD = ".withheld.json";
const RESERVED = new Set([READY, USED, WITHHELD]);
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

export type SnapshotUnavailableReason =
  | "no-connection"
  | "unsupported-forge"
  | "no-credentials";

/** The source cannot be downloaded; the agent reports the component as unavailable. */
export class SnapshotUnavailableError extends Error {
  readonly reason: SnapshotUnavailableReason;

  constructor(reason: SnapshotUnavailableReason) {
    super(`Source snapshot unavailable: ${reason}`);
    this.name = "SnapshotUnavailableError";
    this.reason = reason;
  }
}

export type SnapshotDeps = {
  fetchImpl?: typeof fetch;
  getCredentials?: (
    ciConnectionId: string
  ) => Promise<{ forge: string; auth: BitbucketAuth | null }>;
  root?: string;
};

export type Snapshot = { dir: string; commitSha: string; withheld: number };

function cacheRoot(root?: string): string {
  return root ?? process.env.ASSISTANT_CACHE_DIR ?? DEFAULT_ROOT;
}

// Concurrent callers for one snapshot share a single download.
const inFlight = new Map<string, Promise<Snapshot>>();

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readWithheld(dir: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(dir, WITHHELD), "utf8")
    );
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

async function touchUsed(dir: string): Promise<void> {
  const now = new Date();
  try {
    await utimes(join(dir, USED), now, now);
  } catch {
    await writeFile(join(dir, USED), "");
  }
}

/** The repo-relative path of an archive entry, or null when it must be skipped. */
function relativePath(name: string): string | null {
  if (name.startsWith("/") || name.includes("\0") || name.includes("\\")) {
    return null;
  }
  const segments = name.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return null;
  // The first segment is the archive's single top-level folder.
  const rest = segments.slice(1);
  return rest.length === 0 ? null : rest.join("/");
}

async function extractArchive(
  body: ReadableStream<Uint8Array>,
  dir: string
): Promise<string[]> {
  const withheld: string[] = [];
  const extract = tar.extract();
  const finished = pipeline(
    Readable.fromWeb(body as unknown as NodeWebStream),
    createGunzip(),
    extract
  );
  // An unhandled rejection must not outlive a failed iteration below.
  finished.catch(() => undefined);
  const base = resolve(dir) + sep;
  try {
    for await (const entry of extract) {
      const { header } = entry;
      const rel =
        header.type === "file" || header.type === "contiguous-file"
          ? relativePath(header.name)
          : null;
      if (rel === null || RESERVED.has(rel)) {
        entry.resume();
        continue;
      }
      if (isWithheldPath(rel) || header.size > MAX_ENTRY_BYTES) {
        withheld.push(rel);
        entry.resume();
        continue;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of entry) chunks.push(chunk as Buffer);
      const content = Buffer.concat(chunks);
      if (
        fileVerdict(rel, content.toString("utf8"), content.length) !== "allowed"
      ) {
        withheld.push(rel);
        continue;
      }
      const target = resolve(dir, rel);
      if (!target.startsWith(base)) continue;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await finished;
  } catch (error) {
    extract.destroy();
    throw error;
  }
  return withheld.sort();
}

async function build(
  root: string,
  repoFullName: string,
  sha: string,
  auth: BitbucketAuth,
  fetchImpl: typeof fetch,
  dir: string
): Promise<Snapshot> {
  const temp = `${dir}.tmp-${randomUUID()}`;
  await mkdir(temp, { recursive: true });
  try {
    const body = await downloadArchive(auth, repoFullName, sha, fetchImpl);
    const withheld = await extractArchive(body, temp);
    await writeFile(join(temp, WITHHELD), JSON.stringify(withheld));
    await writeFile(join(temp, USED), "");
    await writeFile(join(temp, READY), "");
    // A leftover without .ready is a crashed earlier build.
    await rm(dir, { recursive: true, force: true });
    await rename(temp, dir);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  // Best effort: eviction never fails a download that succeeded.
  evictSnapshots(new Date(), { root }).catch(() => undefined);
  return { dir, commitSha: sha, withheld: (await readWithheld(dir)).length };
}

/**
 * Downloads the source at its commit into the cache (once per repo and commit)
 * and returns its directory. Withheld files (secrets) are never written; their
 * paths are listed in `<dir>/.withheld.json`.
 */
export async function ensureSnapshot(
  source: AssistantSource,
  deps: SnapshotDeps = {}
): Promise<Snapshot> {
  if (source.ciConnectionId === null) {
    throw new SnapshotUnavailableError("no-connection");
  }
  const { forge, auth } = await (deps.getCredentials ?? getForgeCredentials)(
    source.ciConnectionId
  );
  if (forge !== "bitbucket") {
    throw new SnapshotUnavailableError("unsupported-forge");
  }
  if (!auth) throw new SnapshotUnavailableError("no-credentials");
  if (!REPO_PATTERN.test(source.repoFullName)) {
    throw new Error("Invalid repository name for a snapshot");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sha =
    source.commitSha ??
    (await getBranchHead(auth, source.repoFullName, source.ref, fetchImpl));
  if (!SHA_PATTERN.test(sha))
    throw new Error("Invalid commit sha for a snapshot");

  const root = cacheRoot(deps.root);
  const dir = join(root, source.repoFullName.replace("/", "__"), sha);
  // No await between the lookup and the set: that is what makes callers share.
  let pending = inFlight.get(dir);
  if (!pending) {
    pending = (async () => {
      if (await pathExists(join(dir, READY))) {
        return {
          dir,
          commitSha: sha,
          withheld: (await readWithheld(dir)).length,
        };
      }
      await mkdir(dirname(dir), { recursive: true });
      return build(root, source.repoFullName, sha, auth, fetchImpl, dir);
    })().finally(() => inFlight.delete(dir));
    inFlight.set(dir, pending);
  }
  const snapshot = await pending;
  await touchUsed(dir);
  return snapshot;
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory()
      ? await directorySize(path)
      : (await stat(path)).size;
  }
  return total;
}

/**
 * Removes snapshots not used for 14 days, then the least recently used until
 * the cache fits in 5 GiB. Also clears abandoned partial downloads. Returns
 * the number of snapshots removed.
 */
export async function evictSnapshots(
  now: Date = new Date(),
  options: { root?: string; maxBytes?: number } = {}
): Promise<number> {
  const base = cacheRoot(options.root);
  const maxBytes = options.maxBytes ?? MAX_TOTAL_BYTES;
  type Item = { dir: string; usedAt: number; size: number };
  const items: Item[] = [];
  let removed = 0;
  let repos: string[];
  try {
    repos = await readdir(base);
  } catch {
    return 0;
  }
  for (const repo of repos) {
    const repoDir = join(base, repo);
    let children: string[];
    try {
      children = await readdir(repoDir);
    } catch {
      continue;
    }
    for (const name of children) {
      const dir = join(repoDir, name);
      let usedAt: number;
      try {
        usedAt = (await stat(join(dir, USED))).mtimeMs;
      } catch {
        usedAt = (await stat(dir)).mtimeMs;
      }
      if (name.includes(".tmp-")) {
        if (now.getTime() - usedAt > STALE_TEMP_MS) {
          await rm(dir, { recursive: true, force: true });
        }
        continue;
      }
      if (inFlight.has(dir)) continue;
      if (now.getTime() - usedAt > RETENTION_DAYS * DAY_MS) {
        await rm(dir, { recursive: true, force: true });
        removed++;
        continue;
      }
      items.push({ dir, usedAt, size: await directorySize(dir) });
    }
  }
  let total = items.reduce((sum, i) => sum + i.size, 0);
  for (const item of items.sort((a, b) => a.usedAt - b.usedAt)) {
    if (total <= maxBytes) break;
    await rm(item.dir, { recursive: true, force: true });
    total -= item.size;
    removed++;
  }
  return removed;
}
