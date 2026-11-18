import {
  readFile as fsReadFile,
  lstat,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { fileVerdict, isWithheldPath } from "../secret-filter";

/**
 * Read-only code tools over ready snapshots. Everything returned here may be
 * sent to the model provider, so every path passes `isWithheldPath` and every
 * file content passes `fileVerdict` before it is listed, matched or returned.
 */

export type SnapshotRef = {
  componentKey: string;
  dir: string;
  commitSha: string;
};

export type ToolMeta = {
  paths?: string[];
  ranges?: string[];
  issueKeys?: string[];
  docSlugs?: string[];
  /** Jira attachment ids whose content was sent (audit). */
  attachmentIds?: string[];
  withheld?: number;
  /** Automatic context: the project key a code tool read (audit). */
  project?: string;
  /** Automatic context: the project keys list_projects returned (audit). */
  projectKeys?: string[];
  /** Panel tools: the environment read, as "PROJECTKEY/slug" (audit). */
  environment?: string;
  /** get_environment_status: whether the live probe ran (audit). */
  checked?: boolean;
};

export type ToolResult<T> =
  | { ok: true; data: T; meta: ToolMeta }
  | { ok: false; error: string; meta: ToolMeta };

export const MAX_LIST_PATHS = 150;
/** Withheld paths named in one list_files result (the rest are only counted). */
export const MAX_WITHHELD_PATHS = 50;
export const MAX_SEARCH_MATCHES = 40;
export const CONTEXT_LINES = 2;
export const MAX_READ_LINES = 250;
export const MAX_READ_BYTES = 48 * 1024;
/**
 * Lines longer than this are cut before matching and output. This only bounds
 * output size and per-line work; it is NOT a ReDoS defence (see `unsafeRegex`).
 */
export const MAX_LINE_CHARS = 2000;
/** Total budget for one search result (paths + text + context). */
export const MAX_SEARCH_BYTES = 32 * 1024;
export const MAX_REGEX_LENGTH = 200;
/** Files larger than this are skipped by search/read and counted as withheld. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export const WITHHELD_FILE_ERROR =
  "File withheld: it may contain credentials (not sent to the assistant).";

/** Snapshot bookkeeping files at each snapshot root; never shown. */
const WITHHELD_LIST = ".withheld.json";
const RESERVED = new Set([".ready", ".used", WITHHELD_LIST]);

/**
 * Paths (relative to the snapshot root) that `ensureSnapshot` did not write
 * because they may hold secrets; listed in `<dir>/.withheld.json`. Read once
 * per tool call. Names are shown to the model, content never exists on disk.
 */
async function loadWithheld(snap: SnapshotRef): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(
      await fsReadFile(join(snap.dir, WITHHELD_LIST), "utf8")
    );
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

/** Component-prefixed withheld paths of the snapshots that match `matcher`. */
async function matchingWithheld(
  snaps: SnapshotRef[],
  matcher: Bun.Glob | null
): Promise<string[]> {
  const lists = await Promise.all(snaps.map(loadWithheld));
  return snaps.flatMap((snap, i) =>
    (lists[i] ?? [])
      .map((rel) => `${snap.componentKey}/${rel}`)
      .filter((path) => !matcher || matcher.match(path))
  );
}

function fail(error: string, meta: ToolMeta = {}): ToolResult<never> {
  return { ok: false, error, meta };
}

type Entry = { path: string; abs: string; snap: SnapshotRef };

/** Walks a snapshot without following symlinks; yields sorted, non-withheld files. */
async function* walk(
  snap: SnapshotRef,
  counter: { withheld: number }
): AsyncGenerator<Entry> {
  async function* rec(rel: string): AsyncGenerator<Entry> {
    const abs = rel === "" ? snap.dir : join(snap.dir, rel);
    const items = await readdir(abs, { withFileTypes: true }).catch(() => []);
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      const childRel = rel === "" ? item.name : `${rel}/${item.name}`;
      if (rel === "" && RESERVED.has(item.name)) continue;
      if (item.isDirectory()) {
        yield* rec(childRel);
      } else if (item.isFile()) {
        if (isWithheldPath(childRel)) {
          counter.withheld++;
          continue;
        }
        yield {
          path: `${snap.componentKey}/${childRel}`,
          abs: join(abs, item.name),
          snap,
        };
      }
    }
  }
  yield* rec("");
}

function compileGlob(glob: string | undefined): Bun.Glob | null {
  return glob?.trim() ? new Bun.Glob(glob.trim()) : null;
}

export async function listFiles(
  snaps: SnapshotRef[],
  glob: string
): Promise<
  ToolResult<{
    paths: string[];
    truncated: boolean;
    /** Matching files not sent (count), when there are any. */
    withheld?: number;
    /** Up to MAX_WITHHELD_PATHS of their names. */
    withheldPaths?: string[];
  }>
> {
  let matcher: Bun.Glob | null;
  try {
    matcher = compileGlob(glob);
  } catch (e) {
    return fail(`Invalid glob: ${(e as Error).message}`);
  }
  const withheldPaths = await matchingWithheld(snaps, matcher);
  const counter = { withheld: withheldPaths.length };
  const paths: string[] = [];
  let truncated = false;
  outer: for (const snap of snaps) {
    for await (const entry of walk(snap, counter)) {
      if (matcher && !matcher.match(entry.path)) continue;
      if (paths.length >= MAX_LIST_PATHS) {
        truncated = true;
        break outer;
      }
      paths.push(entry.path);
    }
  }
  return {
    ok: true,
    data:
      counter.withheld > 0
        ? {
            paths,
            truncated,
            withheld: counter.withheld,
            ...(withheldPaths.length > 0 && {
              withheldPaths: withheldPaths.slice(0, MAX_WITHHELD_PATHS),
            }),
          }
        : { paths, truncated },
    meta: { withheld: counter.withheld },
  };
}

/**
 * Reads a file's text after the content-level secret check. Returns null when
 * the file is unreadable, too large, binary or withheld.
 */
async function loadAllowed(
  relPath: string,
  abs: string
): Promise<string | null> {
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile() || info.size > MAX_FILE_BYTES) return null;
  const buf = await fsReadFile(abs).catch(() => null);
  if (!buf) return null;
  const text = buf.toString("utf8");
  return fileVerdict(relPath, text, buf.length) === "allowed" ? text : null;
}

/**
 * JS regexes cannot be interrupted, so model-supplied patterns are screened
 * up front: too long, or a quantified group (`+`, `*`, `{n,}`, `{n,m}`) whose
 * body itself contains an unbounded quantifier (`(a+)+`, `(\w+\s?)*`).
 * Returns a reason, or null when the pattern looks safe.
 */
export function unsafeRegex(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_LENGTH) {
    return `Regex is longer than ${MAX_REGEX_LENGTH} characters; use a shorter pattern or a literal search (regex: false).`;
  }
  const nested =
    "Regex has nested quantifiers (risk of catastrophic backtracking); simplify it or use a literal search (regex: false).";
  const stack: boolean[] = []; // per open group: body has an unbounded quantifier
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "(") stack.push(false);
    else if (c === "+" || c === "*") {
      if (stack.length) stack[stack.length - 1] = true;
    } else if (c === "{") {
      const m = /^\{\d+,\d*\}/.exec(pattern.slice(i));
      if (m?.[0].endsWith(",}") && stack.length) {
        stack[stack.length - 1] = true;
      }
    } else if (c === ")") {
      const unbounded = stack.pop() ?? false;
      const rest = pattern.slice(i + 1);
      const quantified = /^(?:[+*]|\{\d+(?:,\d*)?\})/.test(rest);
      if (unbounded && quantified) return nested;
      if (unbounded && stack.length) stack[stack.length - 1] = true;
    }
  }
  return null;
}

function toInt(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
}

export type SearchMatch = {
  path: string;
  line: number;
  text: string;
  context: string[];
};

export async function searchCode(
  snaps: SnapshotRef[],
  opts: {
    pattern: string;
    regex?: boolean;
    glob?: string;
    ignoreCase?: boolean;
  }
): Promise<
  ToolResult<{
    matches: SearchMatch[];
    truncated: boolean;
    /** Files in scope that were not searched (count), when there are any. */
    withheld?: number;
  }>
> {
  if (!opts.pattern) return fail("Pattern must not be empty.");
  if (opts.regex) {
    const reason = unsafeRegex(opts.pattern);
    if (reason) return fail(reason);
  }
  let re: RegExp;
  try {
    const source = opts.regex
      ? opts.pattern
      : opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(source, opts.ignoreCase ? "i" : "");
  } catch (e) {
    return fail(`Invalid regular expression: ${(e as Error).message}`);
  }
  let matcher: Bun.Glob | null;
  try {
    matcher = compileGlob(opts.glob);
  } catch (e) {
    return fail(`Invalid glob: ${(e as Error).message}`);
  }

  const counter = {
    withheld: (await matchingWithheld(snaps, matcher)).length,
  };
  const matches: SearchMatch[] = [];
  const hitPaths = new Set<string>();
  let truncated = false;
  let bytes = 0;

  outer: for (const snap of snaps) {
    for await (const entry of walk(snap, counter)) {
      if (matcher && !matcher.match(entry.path)) continue;
      const rel = entry.path.slice(snap.componentKey.length + 1);
      const text = await loadAllowed(rel, entry.abs);
      if (text === null) {
        counter.withheld++;
        continue;
      }
      const lines = splitLines(text);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(clip(lines[i] ?? ""))) continue;
        if (matches.length >= MAX_SEARCH_MATCHES) {
          truncated = true;
          break outer;
        }
        const context: string[] = [];
        for (
          let j = Math.max(0, i - CONTEXT_LINES);
          j <= Math.min(lines.length - 1, i + CONTEXT_LINES);
          j++
        ) {
          if (j !== i) context.push(clip(lines[j] ?? ""));
        }
        const match = {
          path: entry.path,
          line: i + 1,
          text: clip(lines[i] ?? ""),
          context,
        };
        bytes += Buffer.byteLength(JSON.stringify(match));
        if (bytes > MAX_SEARCH_BYTES) {
          truncated = true;
          break outer;
        }
        matches.push(match);
        hitPaths.add(entry.path);
      }
    }
  }
  return {
    ok: true,
    data:
      counter.withheld > 0
        ? { matches, truncated, withheld: counter.withheld }
        : { matches, truncated },
    meta: { paths: [...hitPaths], withheld: counter.withheld },
  };
}

/** Resolves `<componentKey>/<rel>` to an absolute path inside its snapshot. */
async function resolvePath(
  snaps: SnapshotRef[],
  path: string
): Promise<
  | { snap: SnapshotRef; rel: string; abs: string }
  | { error: string; withheld?: true }
> {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/")
  ) {
    return { error: "Invalid path." };
  }
  const slash = path.indexOf("/");
  const key = slash === -1 ? path : path.slice(0, slash);
  const rel = slash === -1 ? "" : path.slice(slash + 1);
  const snap = snaps.find((s) => s.componentKey === key);
  if (!snap) return { error: `Unknown component "${key}".` };
  const segments = rel.split("/");
  if (rel === "" || segments.some((s) => s === ".." || s === "." || s === "")) {
    return { error: "Invalid path." };
  }
  if (RESERVED.has(rel)) return { error: "File not found." };
  // Withheld files were never written, so check the list before the disk.
  if ((await loadWithheld(snap)).includes(rel)) {
    return { error: WITHHELD_FILE_ERROR, withheld: true };
  }
  const abs = join(snap.dir, rel);
  try {
    // Every component must be a real directory/file: no symlinks anywhere,
    // consistent with `walk`, so a link cannot reach withheld or outside files.
    let cur = snap.dir;
    for (const [i, segment] of segments.entries()) {
      cur = join(cur, segment);
      const info = await lstat(cur);
      if (info.isSymbolicLink()) return { error: "File not found." };
      if (i === segments.length - 1) {
        if (info.isDirectory()) return { error: "Not a file." };
        if (!info.isFile()) return { error: "File not found." };
      } else if (!info.isDirectory()) {
        return { error: "File not found." };
      }
    }
    const [root, real] = await Promise.all([realpath(snap.dir), realpath(abs)]);
    if (real !== join(root, rel)) return { error: "File not found." };
  } catch {
    return { error: "File not found." };
  }
  return { snap, rel, abs };
}

export async function readFile(
  snaps: SnapshotRef[],
  opts: { path: string; startLine?: number; endLine?: number }
): Promise<
  ToolResult<{
    path: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    text: string;
  }>
> {
  const resolved = await resolvePath(snaps, opts.path);
  if ("error" in resolved) {
    return fail(resolved.error, resolved.withheld ? { withheld: 1 } : {});
  }
  if (isWithheldPath(resolved.rel)) {
    return fail(WITHHELD_FILE_ERROR, { withheld: 1 });
  }
  const text = await loadAllowed(resolved.rel, resolved.abs);
  if (text === null) return fail(WITHHELD_FILE_ERROR, { withheld: 1 });

  const lines = splitLines(text);
  const totalLines = lines.length;
  const start = Math.max(1, toInt(opts.startLine) ?? 1);
  if (start > totalLines && totalLines > 0) {
    return fail(
      `startLine ${start} is beyond the end of the file (${totalLines} lines).`
    );
  }
  const requestedEnd = toInt(opts.endLine) ?? start + MAX_READ_LINES - 1;
  const end = Math.min(totalLines, requestedEnd, start + MAX_READ_LINES - 1);
  if (end < start && totalLines > 0) {
    return fail("endLine must not be before startLine.");
  }

  const out: string[] = [];
  let bytes = 0;
  let last = start - 1;
  for (let n = start; n <= end; n++) {
    const row = `${n}: ${clip(lines[n - 1] ?? "")}`;
    const size = Buffer.byteLength(row) + 1;
    if (bytes + size > MAX_READ_BYTES) break;
    bytes += size;
    out.push(row);
    last = n;
  }
  const path = opts.path;
  return {
    ok: true,
    data: {
      path,
      startLine: start,
      endLine: last,
      totalLines,
      text: out.join("\n"),
    },
    meta: { paths: [path], ranges: [`${path}:${start}-${last}`] },
  };
}
