// A hand port of the `.env` reader Docker Compose v2 uses: compose-go v2.16.2
// `dotenv/parser.go` (statements, names, quoting, escapes), `dotenv/
// godotenv.go` (`parseWithLookup`: BOM, `expandVariables`) and
// `template/template.go` (`Substitute`: `$$`, `$X`, `${X}`, `:-`, `-`, `:?`,
// `?`, `:+`, `+`). The same version `env-file.ts` renders for.
//
// Pure and client-safe (no Node/Bun API): the browser parses pasted text with
// it, the server parses the files it reads, and both see the same entries.
//
// Differences from compose-go, all deliberate:
// - Lookup is the names defined earlier in the text only (compose-go's
//   envMap). The deploy shell's environment is unknown, so it is never
//   consulted: an unknown reference resolves to empty and is listed in the
//   entry's `unresolvedRefs`.
// - A required form (`${X:?msg}`, `${X?msg}`) whose name is not in the text
//   is such an unknown reference too (the shell might define it); one whose
//   name is in the text but fails the check is an error, as in Compose.
// - A name with no `=`/`:` (compose-go's "inherited from the shell" form, or
//   the last line without one) and an empty name are errors.
// - Duplicates: the last definition wins, as in Compose; only it is returned,
//   with `duplicate: true`.
// - Errors carry the statement's line and nothing else: no file text.
// - Line numbers are counted exactly (compose-go's counter drifts on
//   inherited names and reports an unterminated quote at its last line).

export interface DotenvEntry {
  name: string;
  value: string;
  /** 1-based line where the statement starts. */
  line: number;
  /** Referenced names not defined earlier in the text, each once. */
  unresolvedRefs: string[];
  /** The name was defined more than once; this is the last definition. */
  duplicate: boolean;
}

export type DotenvResult =
  | { entries: DotenvEntry[] }
  | { error: { line: number } };

/** Thrown inside the parser; carries no text so none can leak. */
class DotenvError extends Error {
  constructor() {
    super("Invalid .env statement");
  }
}

// parser.go isSpace: space characters but not line breaks.
function isSpace(c: string): boolean {
  switch (c) {
    case "\t":
    case "\v":
    case "\f":
    case "\r":
    case " ":
    case "\u0085":
    case "\u00a0":
      return true;
  }
  return false;
}

// Go unicode.IsSpace (Latin-1 spaces plus the White_Space Z characters).
const UNICODE_SPACE =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;

function isUnicodeSpace(c: string): boolean {
  return UNICODE_SPACE.test(c);
}

function trimRightUnicodeSpace(s: string): string {
  let end = s.length;
  while (end > 0 && isUnicodeSpace(s[end - 1] as string)) end--;
  return s.slice(0, end);
}

// parser.go locateKeyName: name runes are unicode.IsLetter, unicode.IsNumber
// or one of `_ . - [ ]`.
const NAME_RUNE = /^[\p{L}\p{N}_.\-[\]]$/u;

// parser.go exportRegex `^export\s+` (Go `\s` is `[\t\n\f\r ]`).
const EXPORT_PREFIX = /^export[\t\n\f\r ]+/;

// --- template/template.go -------------------------------------------------

// DefaultPattern: `\$(?i:(?P<escaped>\$)|(?P<named>[_a-z][_a-z0-9]*)|
// {(?:(?P<braced>[_a-z][_a-z0-9]*(?::?[-+?](.*))?)}|(?P<invalid>)))`.
// Go's `.` excludes only `\n`; `u` makes `i` fold like Go (`ſ`, `K`).
const PATTERN_SOURCE =
  "\\$(?:(\\$)|([_a-z][_a-z0-9]*)|\\{(?:([_a-z][_a-z0-9]*(?::?[-+?](?:[^\\n]*))?)\\}|()))";

type Lookup = (name: string) => string | undefined;

// The interpolation separators in getSubstitutionFunctionForTemplate's order.
const SEPARATORS = [":?", "?", ":-", "-", ":+", "+"] as const;
type Separator = (typeof SEPARATORS)[number];

/**
 * getSubstitutionFunctionForTemplate: the separator occurring first in the
 * matched template (ties are impossible: the candidates sharing a first
 * character are told apart by the second).
 */
function pickSeparator(template: string): Separator | null {
  let best: Separator | null = null;
  let bestIndex = -1;
  for (const sep of SEPARATORS) {
    const i = template.indexOf(sep);
    if (i >= 0 && (bestIndex < 0 || i < bestIndex)) {
      best = sep;
      bestIndex = i;
    }
  }
  return best;
}

// getFirstBraceClosingIndex: the `}` balancing the first `{` (the character
// after each `{` is skipped, as upstream does).
function firstBraceClosingIndex(s: string): number {
  let open = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "}") {
      open--;
      if (open === 0) return i;
    }
    if (s[i] === "{") {
      open++;
      i++;
    }
  }
  return -1;
}

// partition: split at the first `sep`.
function partition(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

/**
 * The substitute functions (withDefaultWhenAbsence, withDefaultWhenPresence,
 * withRequired). Returns null when `substitution` lacks `sep` (not applied).
 */
function applySeparator(
  sep: Separator,
  substitution: string,
  lookup: Lookup,
  missing: (name: string) => void
): string | null {
  if (!substitution.includes(sep)) return null;
  const [name, operand] = partition(substitution, sep);
  const value = lookup(name);
  switch (sep) {
    case ":-":
    case "-":
      if (value === undefined || (sep === ":-" && value === "")) {
        if (value === undefined) missing(name);
        return substitute(operand, lookup, missing);
      }
      return value;
    case ":+":
    case "+":
      if (value !== undefined && (sep === "+" || value !== "")) {
        return substitute(operand, lookup, missing);
      }
      if (value === undefined) missing(name);
      return value ?? "";
    case ":?":
    case "?":
      if (value === undefined) {
        // Not in the text: the deploy shell might define it (see the header).
        missing(name);
        return "";
      }
      if (sep === ":?" && value === "") {
        // Upstream also substitutes the message before failing.
        substitute(operand, lookup, missing);
        throw new DotenvError();
      }
      return value;
  }
}

// DefaultReplacementAppliedFunc.
function replaceMatch(
  match: string,
  lookup: Lookup,
  missing: (name: string) => void
): string {
  const sep = pickSeparator(match);
  const closing = firstBraceClosingIndex(match);
  let rest = "";
  let template = match;
  if (closing > -1) {
    rest = match.slice(closing + 1);
    template = match.slice(0, closing + 1);
  }
  const groups = new RegExp(PATTERN_SOURCE, "iu").exec(template);
  if (groups === null) throw new DotenvError();
  if (groups[1] !== undefined) return groups[1];

  let substitution = groups[2];
  let braced = false;
  if (substitution === undefined) {
    substitution = groups[3];
    braced = true;
  }
  if (substitution === undefined || substitution === "") {
    throw new DotenvError(); // InvalidTemplateError
  }

  if (braced && sep !== null) {
    const value = applySeparator(sep, substitution, lookup, missing);
    if (value !== null) return value + substitute(rest, lookup, missing);
  }

  const value = lookup(substitution);
  if (value === undefined) missing(substitution);
  return value ?? "";
}

// Substitute / SubstituteWithOptions (ReplaceAllStringFunc over the pattern).
// The first error aborts, where upstream keeps replacing but returns it: the
// parse fails either way.
function substitute(
  template: string,
  lookup: Lookup,
  missing: (name: string) => void
): string {
  const pattern = new RegExp(PATTERN_SOURCE, "giu");
  let out = "";
  let last = 0;
  for (const m of template.matchAll(pattern)) {
    out += template.slice(last, m.index) + replaceMatch(m[0], lookup, missing);
    last = m.index + m[0].length;
  }
  return out + template.slice(last);
}

// --- dotenv/parser.go -----------------------------------------------------

// expandEscapes: escapeSeqRegex `(\\(?:[abcfnrtv$"\\]|0\d{0,3}))`, each match
// unquoted with Go strconv.UnquoteChar; `\$` becomes `$$` for Substitute.
const ESCAPE_SEQ = /\\(?:([abcfnrtv$"\\])|0([0-9]{0,3}))/g;
const SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "\\": "\\",
};

function expandEscapes(value: string): string {
  return value.replace(
    ESCAPE_SEQ,
    (match, ch: string | undefined, digits: string | undefined) => {
      if (ch === "$") return "$$";
      if (ch !== undefined) return SIMPLE_ESCAPES[ch] ?? match; // `\c`: no Go escape
      // `\0ddd` -> Go `\ddd`: exactly three octal digits, at most 0o377.
      if (digits !== undefined && /^[0-7]{3}$/.test(digits)) {
        const code = Number.parseInt(digits, 8);
        if (code <= 0o377) return String.fromCharCode(code);
      }
      return match;
    }
  );
}

/** Parses `.env` text the way Docker Compose reads a project's `.env`. */
export function parseDotenv(text: string): DotenvResult {
  // godotenv.go parseWithLookup: skip a UTF-8 BOM.
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;

  // Line of a position, counted forward (positions only grow).
  let linePos = 0;
  let lineNo = 1;
  const lineAt = (pos: number): number => {
    for (; linePos < pos; linePos++) if (src[linePos] === "\n") lineNo++;
    return lineNo;
  };

  const values = new Map<string, string>();
  const byName = new Map<string, DotenvEntry>();
  let pos = 0;
  let statementLine = 1;

  try {
    for (;;) {
      // getStatementStart: skip unicode spaces and `#` comment lines.
      while (pos < src.length) {
        const c = src[pos] as string;
        if (isUnicodeSpace(c)) {
          pos++;
        } else if (c === "#") {
          const nl = src.indexOf("\n", pos);
          pos = nl === -1 ? src.length : nl;
        } else {
          break;
        }
      }
      if (pos >= src.length) break;
      statementLine = lineAt(pos);

      // locateKeyName.
      const exportMatch = EXPORT_PREFIX.exec(src.slice(pos, pos + 64));
      if (exportMatch) {
        pos += "export".length;
        while (pos < src.length && isSpace(src[pos] as string)) pos++;
        statementLine = lineAt(pos);
      }
      const keyStart = pos;
      let separator: string | null = null;
      while (pos < src.length) {
        const c = String.fromCodePoint(src.codePointAt(pos) as number);
        if (c === "=" || c === ":" || c === "\n") {
          separator = c;
          break;
        }
        if (!isSpace(c) && !NAME_RUNE.test(c)) throw new DotenvError();
        pos += c.length;
      }
      // No separator before the end, or the "inherited" bare-name form.
      if (separator === null || separator === "\n") throw new DotenvError();
      const name = trimRightUnicodeSpace(src.slice(keyStart, pos));
      if (name === "" || name.includes(" ")) throw new DotenvError();
      pos++;
      while (pos < src.length && isSpace(src[pos] as string)) pos++;

      // extractVarValue.
      const unresolved: string[] = [];
      const lookup: Lookup = (n) => values.get(n);
      const missing = (n: string) => {
        if (!unresolved.includes(n)) unresolved.push(n);
      };
      let value: string;
      const quote = src[pos];
      if (quote !== "'" && quote !== '"') {
        const nl = src.indexOf("\n", pos);
        let raw = src.slice(pos, nl === -1 ? src.length : nl);
        pos = nl === -1 ? src.length : nl + 1;
        const comment = raw.indexOf(" #");
        if (comment !== -1) raw = raw.slice(0, comment);
        value = substitute(trimRightUnicodeSpace(raw), lookup, missing);
      } else {
        // A `\` before the closing quote escapes it (and is dropped); before
        // any other character it is kept along with it.
        let chars = "";
        let escaped = false;
        let closed = -1;
        for (let i = pos + 1; i < src.length; i++) {
          const c = src[i] as string;
          if (c !== quote) {
            if (!escaped && c === "\\") {
              escaped = true;
              continue;
            }
            if (escaped) {
              escaped = false;
              chars += "\\";
            }
            chars += c;
            continue;
          }
          if (escaped) {
            escaped = false;
            chars += c;
            continue;
          }
          closed = i;
          break;
        }
        if (closed === -1) throw new DotenvError(); // unterminated quoted value
        value =
          quote === '"'
            ? substitute(expandEscapes(chars), lookup, missing)
            : chars;
        pos = closed + 1;
      }

      const previous = byName.get(name);
      if (previous) byName.delete(name);
      byName.set(name, {
        name,
        value,
        line: statementLine,
        unresolvedRefs: unresolved,
        duplicate: previous !== undefined,
      });
      values.set(name, value);
    }
  } catch (err) {
    if (err instanceof DotenvError) return { error: { line: statementLine } };
    throw err;
  }

  // Re-inserting a duplicate moves it to the end: the map is in line order.
  return { entries: [...byName.values()] };
}
