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

export type FileKind = "code" | "config" | "other";

type PathRule = {
  name: string;
  test: (dirs: string[], base: string, kind: FileKind) => boolean;
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

const CODE_EXTENSIONS = new Set([
  "java",
  "kt",
  "groovy",
  "scala",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "vue",
  "py",
  "go",
  "cs",
  "php",
  "rb",
]);
const CONFIG_EXTENSIONS = new Set([
  "yml",
  "yaml",
  "properties",
  "conf",
  "ini",
  "cfg",
  "toml",
  "json",
  "xml",
]);

const PATH_RULES: PathRule[] = [
  { name: "git-dir", test: (dirs) => dirs.includes(".git") },
  { name: "node-modules", test: (dirs) => dirs.includes("node_modules") },
  { name: "secrets-dir", test: (dirs) => dirs.includes("secrets") },
  {
    name: "dotenv",
    test: (_d, base) =>
      base === ".envrc" ||
      ((base === ".env" || base.startsWith(".env.")) &&
        !TEMPLATE_SUFFIXES.some((s) => base.endsWith(s))),
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
    // Source files such as CredentialsService.java are ordinary code.
    name: "credentials-or-secrets-name",
    test: (_d, base, kind) =>
      kind !== "code" &&
      (base.startsWith("credentials") || base.startsWith("secrets")),
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

/** Classifies a path by extension; "other" is treated like "config" for key rules. */
export function fileKind(path: string): FileKind {
  const { base } = split(path);
  if (base === ".env" || base.startsWith(".env.") || base === ".envrc") {
    return "config";
  }
  if (base === ".npmrc") return "config";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (CONFIG_EXTENSIONS.has(ext)) return "config";
  return "other";
}

/** Path-only check. Content-dependent cases are decided in `fileVerdict`. */
export function isWithheldPath(path: string): boolean {
  const { dirs, base } = split(path);
  const kind = fileKind(path);
  return PATH_RULES.some((r) => r.test(dirs, base, kind));
}

/** Heuristic: SQL under a seed* dir or named *seed*.sql is likely real data. */
function isSeedSqlPath(path: string): boolean {
  const { dirs, base } = split(path);
  if (!base.endsWith(".sql")) return false;
  return base.includes("seed") || dirs.some((d) => d.startsWith("seed"));
}

/** Patterns that identify a credential by shape alone, in any kind of file. */
const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /ATATT[0-9A-Za-z_\-=]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{36,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/,
];

// Anchored on the literal "://" so long runs of letters cannot cause quadratic scans.
const URL_CREDENTIALS = /:\/\/[^\s:/@]+:([^\s@/]{3,})@/g;

const KEY_NAMES =
  "(?:password|passwd|pwd|secret|client[_-]?secret|secret[_-]?key|token|auth[_-]?token|api[_-]?key|access[_-]?key(?:[_-]?id)?|private[_-]?key)";

// Code: key, optional closing quote, `:`/`=`/`:=`, then a quoted literal of 6+ chars on the same line.
const CODE_KEY_VALUE = new RegExp(
  `${KEY_NAMES}["'\`]?[ \\t]*(?::=|[:=])[ \\t]*["']([^"'\\n]{6,})["']`,
  "gi"
);

// Config: key (also `_auth` for .npmrc), optional closing quote, `:`/`=`/`>`, then a quoted or bare value. Never crosses a newline.
const CONFIG_KEY_VALUE = new RegExp(
  `(?:${KEY_NAMES}|_auth)["']?[ \\t]*[:=>][ \\t]*(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\s"'<]+))`,
  "gi"
);

// Spring XML: <property name="KEY" value="VALUE"> with either attribute order.
const XML_PROPERTY_NAME_FIRST = new RegExp(
  `<property\\s+name\\s*=\\s*["'][\\w.-]*${KEY_NAMES}["']\\s+value\\s*=\\s*["']([^"'\\s]{3,})["']`,
  "gi"
);
const XML_PROPERTY_VALUE_FIRST = new RegExp(
  `<property\\s+value\\s*=\\s*["']([^"'\\s]{3,})["']\\s+name\\s*=\\s*["'][\\w.-]*${KEY_NAMES}["']`,
  "gi"
);

/** `${VAR}`, `$VAR`, `{{ var }}` and `<placeholder>` are references, not literals. */
function isPlaceholder(value: string): boolean {
  return (
    value.startsWith("${") ||
    value.startsWith("{{") ||
    value.startsWith("<") ||
    /^\$[A-Za-z_]/.test(value)
  );
}

/** Words that name the secret itself (UI labels, field-name constants), not its value. */
const LABEL_WORDS = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "clientsecret",
  "secretkey",
  "token",
  "authtoken",
  "apikey",
  "accesskey",
  "accesskeyid",
  "privatekey",
]);

function isCodeSecretValue(value: string): boolean {
  if (value.length < 6 || isPlaceholder(value)) return false;
  // A value with whitespace is prose (i18n text), not a credential.
  if (/\s/.test(value)) return false;
  return !LABEL_WORDS.has(value.toLowerCase().replace(/[_-]/g, ""));
}

function isConfigSecretValue(value: string): boolean {
  if (value.length < 3 || /\s/.test(value)) return false;
  if (/^(?:true|false|null)$/i.test(value)) return false;
  if (value.startsWith("ENC(")) return false; // encrypted (Jasypt)
  if (value.startsWith("${")) {
    // Spring/shell defaults (`${VAR:default}`, `${VAR:-default}`) are literals.
    const def = /^\$\{[^}:]*:-?([^}]*)\}/.exec(value);
    return def !== null && (def[1]?.length ?? 0) >= 3;
  }
  return !isPlaceholder(value);
}

function hasLiteral(
  re: RegExp,
  text: string,
  accept: (value: string) => boolean
): boolean {
  for (const m of text.matchAll(re)) {
    const value = m[1] ?? m[2] ?? m[3] ?? "";
    if (accept(value)) return true;
  }
  return false;
}

/**
 * `kind` "code" only flags quoted string literals assigned to secret-like
 * names; "config" (default, also used for other files) flags bare values too.
 */
export function containsSecret(
  text: string,
  kind: "code" | "config" = "config"
): boolean {
  if (TOKEN_PATTERNS.some((p) => p.test(text))) return true;
  if (hasLiteral(URL_CREDENTIALS, text, (v) => !isPlaceholder(v))) return true;
  return kind === "code"
    ? hasLiteral(CODE_KEY_VALUE, text, isCodeSecretValue)
    : hasLiteral(CONFIG_KEY_VALUE, text, isConfigSecretValue) ||
        hasLiteral(XML_PROPERTY_NAME_FIRST, text, isConfigSecretValue) ||
        hasLiteral(XML_PROPERTY_VALUE_FIRST, text, isConfigSecretValue);
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
  const kind = fileKind(path) === "code" ? "code" : "config";
  return containsSecret(content, kind) ? "withheld" : "allowed";
}

/** What replaces a line of free text that holds a credential. */
export const REDACTED_LINE = "[disembunyikan: berisi kredensial]";

/**
 * Free text written by people (Jira descriptions and comments, knowledge-base
 * documents) cannot be withheld whole like a file: each line that holds a
 * literal secret (config rules) is replaced with REDACTED_LINE instead.
 * `redacted` counts the replaced lines.
 */
export function redactSecretLines(text: string): {
  text: string;
  redacted: number;
} {
  let redacted = 0;
  const lines = text.split("\n").map((line) => {
    if (!containsSecret(line, "config")) return line;
    redacted++;
    return REDACTED_LINE;
  });
  return redacted === 0
    ? { text, redacted }
    : { text: lines.join("\n"), redacted };
}
