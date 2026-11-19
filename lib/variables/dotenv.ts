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
//   is such an unknown reference too: in compose-go the lookup (the shell)
//   takes precedence over the file's own names, so the deploy shell might
//   define it. One whose name is in the text but fails the check is an
//   error, as in Compose with a shell that does not define it.
// - A name with no `=`/`:` (compose-go's "inherited from the shell" form, or
//   the last line without one), a line with only `export`, and an empty name
//   are errors.
// - `${…}` nesting deeper than MAX_NESTING is an error (stack safety).
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
//
// DefaultPattern is `\$(?i:(?P<escaped>\$)|(?P<named>[_a-z][_a-z0-9]*)|
// {(?:(?P<braced>[_a-z][_a-z0-9]*(?::?[-+?](.*))?)}|(?P<invalid>)))`, applied
// with ReplaceAllStringFunc and DefaultReplacementAppliedFunc. It is matched
// here by hand, with the same results, so that the work stays linear in the
// text and the recursion bounded:
// - The greedy `(.*)}` of a braced form with a separator ends at the last `}`
//   on the line (Go's `.` excludes only `\n`); without such a `}` the braced
//   alternative fails and the match is `invalid`.
// - getSubstitutionFunctionForTemplate picks the separator occurring first in
//   the match; `${NAME` holds none of `:?-+`, so it is the one right after
//   the name.
// - Upstream substitutes the text after getFirstBraceClosingIndex (`rest`)
//   recursively and appends it; that text ends at the match's last `}`, so
//   no match inside it could extend past it, and resuming the scan right
//   after the closing brace gives the same result without the recursion.
// - Defaults, alternatives and messages nest (`${A:-${B:-…}}`); past
//   MAX_NESTING levels the statement is refused rather than overflowing the
//   stack (an addition: upstream has no limit).

/** Deepest `${…}` nesting accepted inside one value. */
export const MAX_NESTING = 100;

type Lookup = (name: string) => string | undefined;
type Separator = ":?" | "?" | ":-" | "-" | ":+" | "+";

interface Context {
  lookup: Lookup;
  missing: (name: string) => void;
}

// `[_a-z][_a-z0-9]*` under Go's `(?i)`: `u` makes `i` fold like Go (`ſ`, `K`).
const NAME_AT = /[_a-z][_a-z0-9]*/iuy;

function nameAt(s: string, pos: number): string | null {
  NAME_AT.lastIndex = pos;
  return NAME_AT.exec(s)?.[0] ?? null;
}

// getFirstBraceClosingIndex over s[from, to): the `}` balancing the first
// `{` (the character after each `{` is skipped, as upstream does), or -1.
function firstBraceClosingIndex(s: string, from: number, to: number): number {
  let open = 0;
  for (let i = from; i < to; i++) {
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

/**
 * withDefaultWhenAbsence, withDefaultWhenPresence and withRequired for
 * `${name<sep>operand}`.
 */
function applySeparator(
  sep: Separator,
  name: string,
  operand: string,
  ctx: Context,
  depth: number
): string {
  const value = ctx.lookup(name);
  if (value === undefined) ctx.missing(name);
  switch (sep) {
    case ":-":
    case "-":
      if (value === undefined || (sep === ":-" && value === "")) {
        return substitute(operand, ctx, depth + 1);
      }
      return value;
    case ":+":
    case "+":
      if (value !== undefined && (sep === "+" || value !== "")) {
        return substitute(operand, ctx, depth + 1);
      }
      return value ?? "";
    case ":?":
    case "?":
      // Not in the text: the deploy shell might define it (see the header).
      if (value === undefined) return "";
      if (sep === ":?" && value === "") {
        // Upstream substitutes the message before failing.
        substitute(operand, ctx, depth + 1);
        throw new DotenvError();
      }
      return value;
  }
}

function separatorAt(s: string, pos: number): Separator | null {
  const c = s[pos];
  if (c === "-" || c === "+" || c === "?") return c;
  const next = s[pos + 1];
  if (c === ":" && (next === "-" || next === "+" || next === "?")) {
    return `:${next}`;
  }
  return null;
}

// The plain `$NAME` / `${NAME}` lookup; a miss resolves to empty.
function resolve(name: string, ctx: Context): string {
  const value = ctx.lookup(name);
  if (value === undefined) ctx.missing(name);
  return value ?? "";
}

/** template.Substitute with the text's earlier names as the mapping. */
function substitute(template: string, ctx: Context, depth: number): string {
  if (depth > MAX_NESTING) throw new DotenvError();
  // The last `}` on the line holding `pos`; scanning only moves forward.
  let lineEnd = -1;
  let lineLastBrace = -1;
  const lastBraceOnLine = (pos: number): number => {
    if (pos > lineEnd) {
      const nl = template.indexOf("\n", pos);
      lineEnd = nl === -1 ? template.length : nl;
      lineLastBrace = template.lastIndexOf("}", lineEnd - 1);
    }
    return lineLastBrace;
  };

  let out = "";
  let last = 0;
  let i = template.indexOf("$");
  while (i !== -1) {
    const next = template[i + 1];
    let resume: number;
    let value: string;
    if (next === "$") {
      value = "$";
      resume = i + 2;
    } else if (next !== "{") {
      const name = nameAt(template, i + 1);
      if (name === null) {
        i = template.indexOf("$", i + 1); // no match: a literal `$`
        continue;
      }
      value = resolve(name, ctx);
      resume = i + 1 + name.length;
    } else {
      const name = nameAt(template, i + 2);
      if (name === null) throw new DotenvError(); // InvalidTemplateError
      const afterName = i + 2 + name.length;
      if (template[afterName] === "}") {
        value = resolve(name, ctx);
        resume = afterName + 1;
      } else {
        const sep = separatorAt(template, afterName);
        const operandStart = afterName + (sep?.length ?? 0);
        const matchLast = sep === null ? -1 : lastBraceOnLine(operandStart);
        if (sep === null || matchLast < operandStart) {
          throw new DotenvError(); // InvalidTemplateError
        }
        const closing = firstBraceClosingIndex(template, i, matchLast + 1);
        const end = closing === -1 ? matchLast : closing;
        value = applySeparator(
          sep,
          name,
          template.slice(operandStart, end),
          ctx,
          depth
        );
        resume = end + 1;
      }
    }
    out += template.slice(last, i) + value;
    last = resume;
    i = template.indexOf("$", resume);
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
      const ctx: Context = {
        lookup: (n) => values.get(n),
        missing: (n) => {
          if (!unresolved.includes(n)) unresolved.push(n);
        },
      };
      let value: string;
      const quote = src[pos];
      if (quote !== "'" && quote !== '"') {
        const nl = src.indexOf("\n", pos);
        let raw = src.slice(pos, nl === -1 ? src.length : nl);
        pos = nl === -1 ? src.length : nl + 1;
        const comment = raw.indexOf(" #");
        if (comment !== -1) raw = raw.slice(0, comment);
        value = substitute(trimRightUnicodeSpace(raw), ctx, 0);
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
          quote === '"' ? substitute(expandEscapes(chars), ctx, 0) : chars;
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
