import path from "node:path";

// Path confinement for the storage explorer. Every path reaching a backend
// originates from an untrusted client (the explorer sends whatever key/path the
// user clicked or typed), so both backends funnel through these before touching
// a bucket or a filesystem. The zod schema at the action boundary is the first
// gate; these are the second, defence-in-depth layer.

export class PathError extends Error {}

// Normalize an S3 object key or prefix. S3 has no real directories — keys are
// opaque strings — but `..` and absolute paths are still rejected so a tampered
// client can't probe outside the intended prefix layout or emit surprising
// keys. Returns a clean, forward-slash key with no leading slash. A trailing
// slash (a "folder" prefix) is preserved when `allowDir` is set.
export function normalizeS3Key(input: string, allowDir = false): string {
  const raw = input.replace(/\\/g, "/");
  const segments = raw.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new PathError("Path must not contain '..'");
  }
  const key = segments.join("/");
  if (!allowDir && input.endsWith("/")) {
    throw new PathError("Expected a file key, got a folder path");
  }
  return input.endsWith("/") && allowDir && key.length > 0 ? `${key}/` : key;
}

// Confine an SFTP path to `root`. Resolves `input` (which may be relative to
// root or absolute-looking) and guarantees the result never escapes root via
// `..`, symlink-shaped segments, or an absolute path. Returns an absolute posix
// path inside root. Throws PathError on any escape attempt.
export function confineSftpPath(root: string, input: string): string {
  const base = path.posix.normalize(`/${root}`).replace(/\/+$/, "") || "/";
  // Treat the client path as relative to root regardless of leading slash, so
  // "/etc/passwd" resolves under root, not the real filesystem root.
  const rel = input.replace(/^\/+/, "");
  const resolved = path.posix.normalize(path.posix.join(base, rel));
  // Prefix a child must start with. When root is "/", that prefix is just "/"
  // (not "//"), otherwise every subpath fails the startsWith check.
  const prefix = base === "/" ? "/" : `${base}/`;
  if (resolved !== base && !resolved.startsWith(prefix)) {
    throw new PathError("Path escapes the configured root");
  }
  return resolved;
}

// The last path segment, used as the display name. Strips a trailing slash so a
// folder prefix "a/b/" yields "b".
export function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
