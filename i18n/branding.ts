import { IntlMessageFormat } from "intl-messageformat";

// Replace `{{APP_NAME}}` / `{{COMPANY_NAME}}` / `{{EMAIL_DOMAIN}}` tokens in
// translation strings with the instance's branding. Double braces are used so
// the tokens don't collide with ICU's single-brace placeholders (`{name}`).
// `{{COMPANY_NAME}}` falls back to the instance name when no company is set.
//
// The values are passed in: the server reads them from the stored branding
// (lib/instance-branding), the SPA gets them from `/api/bootstrap`, and this
// module runs in both.
//
// The values are admin input and land in ICU message strings that use-intl
// formats later, so ICU syntax in them (`{`, `}`, `<`, an apostrophe, `#`
// inside a plural) must stay literal text. A value without any of those
// characters is inserted as is; otherwise the message is parsed with the
// tokens as placeholders, the values go into its text, and it is printed back
// with each text quoted where ICU needs it.

export type Branding = {
  appName: string;
  companyName: string | null;
  allowedEmailDomain: string;
};

const TOKENS = ["{{APP_NAME}}", "{{COMPANY_NAME}}", "{{EMAIL_DOMAIN}}"];
// Private-use characters: plain text to ICU, never in a catalogue.
const MARKS = ["\uE000", "\uE001", "\uE002"];
const MARK = /[\uE000-\uE002]/g;
const ICU_SYNTAX = /[{}<#']/;

export function applyBranding<T>(value: T, branding: Branding): T {
  const values = [
    branding.appName,
    branding.companyName ?? branding.appName,
    branding.allowedEmailDomain,
  ];
  return brand(
    value,
    values,
    values.some((v) => ICU_SYNTAX.test(v))
  );
}

function brand<T>(value: T, values: string[], quoteValues: boolean): T {
  if (typeof value === "string") {
    return (
      quoteValues ? brandEscaped(value, values) : brandPlain(value, values)
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => brand(item, values, quoteValues)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = brand(v, values, quoteValues);
    }
    return out as T;
  }
  return value;
}

function brandPlain(message: string, values: string[]): string {
  let out = message;
  // Function replacers: a replacement string would expand `$&`, `$'` and the
  // like in the admin-set values.
  TOKENS.forEach((token, i) => {
    out = out.replaceAll(token, () => values[i] ?? "");
  });
  return out;
}

function brandEscaped(message: string, values: string[]): string {
  if (!TOKENS.some((token) => message.includes(token))) return message;
  let marked = message;
  TOKENS.forEach((token, i) => {
    marked = marked.replaceAll(token, MARKS[i] ?? "");
  });
  const fill = (text: string) =>
    text.replace(MARK, (mark) => values[MARKS.indexOf(mark)] ?? "");
  try {
    return print(new IntlMessageFormat(marked, "en").getAst(), false, fill);
  } catch {
    // Not an ICU message (it would not format either way): plain text.
    return brandPlain(message, values);
  }
}

type Ast = ReturnType<IntlMessageFormat["getAst"]>;
type Element = Ast[number];

// Prints the parsed message back as ICU. `inPlural` is whether `#` is the
// count here: in a plural branch and the tags inside it, not in a select.
function print(
  ast: Ast,
  inPlural: boolean,
  fill: (text: string) => string
): string {
  return ast.map((el) => printElement(el, inPlural, fill)).join("");
}

function printElement(
  el: Element,
  inPlural: boolean,
  fill: (text: string) => string
): string {
  switch (el.type) {
    case 0:
      return quote(fill(el.value), inPlural);
    case 1:
      return `{${el.value}}`;
    case 2:
    case 3:
    case 4: {
      const kind = el.type === 2 ? "number" : el.type === 3 ? "date" : "time";
      const style = el.style;
      if (!style) return `{${el.value}, ${kind}}`;
      if (typeof style === "string") return `{${el.value}, ${kind}, ${style}}`;
      const skeleton =
        "pattern" in style
          ? style.pattern
          : style.tokens.map((t) => [t.stem, ...t.options].join("/")).join(" ");
      return `{${el.value}, ${kind}, ::${skeleton}}`;
    }
    case 5:
      return `{${el.value}, select, ${Object.entries(el.options)
        .map(([key, o]) => `${key} {${print(o.value, false, fill)}}`)
        .join(" ")}}`;
    case 6: {
      const kind = el.pluralType === "ordinal" ? "selectordinal" : "plural";
      const offset = el.offset ? ` offset:${el.offset}` : "";
      return `{${el.value}, ${kind},${offset} ${Object.entries(el.options)
        .map(([key, o]) => `${key} {${print(o.value, true, fill)}}`)
        .join(" ")}}`;
    }
    case 7:
      return "#";
    case 8:
      return `<${el.value}>${print(el.children, inPlural, fill)}</${el.value}>`;
  }
  throw new Error("Unknown ICU element");
}

// ICU text, quoted where ICU would read syntax: an apostrophe is always
// doubled (literal inside and outside quotes), and a run of syntax
// characters is wrapped in apostrophes. A quote opens only right before a
// syntax character, the only place ICU starts one.
function quote(text: string, inPlural: boolean): string {
  let out = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === "'") {
      out += "''";
    } else if (
      ch === "{" ||
      ch === "}" ||
      ch === "<" ||
      (inPlural && ch === "#")
    ) {
      if (!quoted) out += "'";
      quoted = true;
      out += ch;
    } else {
      if (quoted) out += "'";
      quoted = false;
      out += ch;
    }
  }
  return quoted ? `${out}'` : out;
}
