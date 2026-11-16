/**
 * Decides which repository files may ever be sent to the Anthropic API.
 * Pure module, no I/O. Paths are repo-relative POSIX; matching is
 * case-insensitive and applies at any depth.
 *
 * Two layers: path rules (`isWithheldPath`) and content rules
 * (`containsSecret`, binary, large seed SQL), combined in `fileVerdict`.
 * `application-*.{yml,yaml,properties}` of any profile are NOT withheld by
 * path; they are withheld only when their content holds a literal secret.
 */

export type FileVerdict = "allowed" | "withheld";

const MAX_SEED_SQL_BYTES = 1024 * 1024;
const BINARY_SNIFF_CHARS = 8192;

type PathRule = {
  name: string;
  test: (segments: string[], base: string) => boolean;
};

const TEMPLATE_SUFFIXES = [".example", ".sample", ".template"];
const KEY_EXTENSIONS = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".kdbx",
  ".sql.gz",
  ".dump",
  ".bak",
];

const PATH_RULES: PathRule[] = [
  { name: "git-dir", test: (dirs) => dirs.includes(".git") },
  { name: "node-modules", test: (dirs) => dirs.includes("node_modules") },
  { name: "secrets-dir", test: (dirs) => dirs.includes("secrets") },
  {
    name: "dotenv",
    test: (_d, base) =>
      (base === ".env" || base.startsWith(".env.")) &&
      !TEMPLATE_SUFFIXES.some((s) => base.endsWith(s)),
  },
  {
    name: "key-or-dump-extension",
    test: (_d, base) => KEY_EXTENSIONS.some((e) => base.endsWith(e)),
  },
  {
    name: "ssh-key-name",
    test: (_d, base) =>
      base.startsWith("id_rsa") || base.startsWith("id_ed25519"),
  },
  {
    name: "credentials-or-secrets-name",
    test: (_d, base) =>
      base.startsWith("credentials") || base.startsWith("secrets"),
  },
];

function split(path: string): { dirs: string[]; base: string } {
  const parts = path
    .toLowerCase()
    .replaceAll("\\", "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  const base = parts.pop() ?? "";
  return { dirs: parts, base };
}

/** Path-only check. Content-dependent cases are decided in `fileVerdict`. */
export function isWithheldPath(path: string): boolean {
  const { dirs, base } = split(path);
  return PATH_RULES.some((r) => r.test(dirs, base));
}

/** Heuristic: SQL under a seed* dir or named *seed*.sql is likely real data. */
function isSeedSqlPath(path: string): boolean {
  const { dirs, base } = split(path);
  if (!base.endsWith(".sql")) return false;
  return base.includes("seed") || dirs.some((d) => d.startsWith("seed"));
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /ATATT[0-9A-Za-z_\-=]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  // key = literal value; `${...}` placeholders are excluded by the first value char.
  /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"'${][^\s"']{5,}/i,
];

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

function isBinary(content: string): boolean {
  return content.slice(0, BINARY_SNIFF_CHARS).includes("\0");
}

export function fileVerdict(
  path: string,
  content: string,
  sizeBytes: number = Buffer.byteLength(content)
): FileVerdict {
  if (isWithheldPath(path)) return "withheld";
  if (isSeedSqlPath(path) && sizeBytes > MAX_SEED_SQL_BYTES) return "withheld";
  if (isBinary(content)) return "withheld";
  return containsSecret(content) ? "withheld" : "allowed";
}
