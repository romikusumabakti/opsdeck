// The version baked into the image (Dockerfile ARG -> ENV). Pure and
// client-safe: no server-only imports.
export const OPSDECK_VERSION: string =
  process.env.OPSDECK_VERSION || "0.0.0-dev";

export type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  /** Beta number for `X.Y.Z-beta.N`; null for a stable release. */
  beta: number | null;
};

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

export function parseVersion(v: string): ParsedVersion | null {
  const m = VERSION_RE.exec(v);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    beta: m[4] === undefined ? null : Number(m[4]),
  };
}

// Semver order: a beta sorts before the stable release of the same X.Y.Z.
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    throw new Error(`Cannot compare unparseable version: ${pa ? b : a}`);
  }
  const order = (x: number, y: number) => (x < y ? -1 : x > y ? 1 : 0);
  return (
    order(pa.major, pb.major) ||
    order(pa.minor, pb.minor) ||
    order(pa.patch, pb.patch) ||
    order(pa.beta ?? Infinity, pb.beta ?? Infinity)
  );
}

export function channelOf(v: string): "stable" | "beta" {
  return parseVersion(v)?.beta == null ? "stable" : "beta";
}
