// Best-effort masking of the Assistant's database results (Stage 9 spec
// F.3): a column whose name holds a sensitive word is replaced with MASK
// before the model sees it. Names are split into tokens (snake_case,
// kebab-case, camelCase, digits) and matched as whole tokens, so
// `shipment_date` or `discard` never match. Pure; shared by the gate and the
// tool.

/** What a masked cell shows. */
export const MASK = "•••";

/** Sensitive words, matched as one whole token (or its plural). */
const SENSITIVE_TOKENS = new Set([
  "password",
  "passwd",
  "pwd",
  "passcode",
  "secret",
  "token",
  "credential",
  "apikey",
  "pin",
  "otp",
  "nik",
  "npwp",
  "ktp",
  "email",
  "phone",
  "telepon",
  "telp",
  "hp",
  "mobile",
  "address",
  "alamat",
  "birth",
  "birthdate",
  "birthday",
  "lahir",
  "dob",
  "rekening",
  "accountnumber",
  "cardnumber",
]);

/** Sensitive phrases spelled as consecutive tokens. */
const SENSITIVE_PHRASES: readonly (readonly string[])[] = [
  ["api", "key"],
  ["account", "number"],
  ["card", "number"],
  ["e", "mail"],
];

/** `passwordHash` → ["password", "hash"]; `APIKey2` → ["api", "key", "2"]. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The singular of a simple English plural (`tokens`, `addresses`). */
function singulars(token: string): string[] {
  const out = [token];
  if (token.endsWith("es")) out.push(token.slice(0, -2));
  if (token.endsWith("s")) out.push(token.slice(0, -1));
  return out;
}

export function isSensitiveName(name: string): boolean {
  const tokens = nameTokens(name);
  if (tokens.some((t) => singulars(t).some((s) => SENSITIVE_TOKENS.has(s)))) {
    return true;
  }
  return SENSITIVE_PHRASES.some((phrase) =>
    tokens.some((_, i) =>
      phrase.every((word, j) => {
        const token = tokens[i + j];
        if (token === undefined) return false;
        // The last word may be plural (`api_keys`).
        return j === phrase.length - 1
          ? singulars(token).includes(word)
          : token === word;
      })
    )
  );
}

export type Cell = string | null;

/**
 * Replaces every cell of a sensitive column with MASK. With one flag per
 * result column (`sensitive`, the gate's resolution of a select list without
 * `*`) the flags decide, so a count of a sensitive column stays a number;
 * otherwise a column is sensitive by its result name.
 * NULL cells are masked too, so the model can't tell which rows hold a
 * value. Returns the masked column names.
 */
export function maskRows(
  columns: readonly string[],
  rows: readonly (readonly Cell[])[],
  sensitive: readonly boolean[] = []
): { rows: Cell[][]; masked: string[] } {
  const aligned = sensitive.length > 0 && sensitive.length === columns.length;
  const hide = columns.map((name, i) =>
    aligned ? sensitive[i] === true : isSensitiveName(name)
  );
  return {
    rows: rows.map((row) => row.map((cell, i) => (hide[i] ? MASK : cell))),
    masked: columns.filter((_, i) => hide[i]),
  };
}
