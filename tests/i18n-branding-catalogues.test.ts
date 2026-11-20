import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { applyBranding } from "@/i18n/branding";
import { locales } from "@/i18n/locales";

// An oracle over the real catalogues: every message that carries a branding
// token, in every locale, renders the same whether applyBranding wrote the
// name into the ICU string or ICU inserted it as an argument value (the
// reference: a value is never read as syntax). The names are built to break
// a naive insertion: braces, apostrophes, `#` inside plurals, tags.

const NAMES = [
  "Ops {x} 'y' #1 <b>",
  "It's",
  "a}b",
  "'{'",
  "<i>x</i>",
  "#",
  "Acme",
];
const DOMAIN = "example.com";

const TOKENS: [string, string][] = [
  ["{{APP_NAME}}", "brandApp"],
  ["{{COMPANY_NAME}}", "brandCompany"],
  ["{{EMAIL_DOMAIN}}", "brandDomain"],
];

type Messages = { [key: string]: string | Messages };

function flatten(
  messages: Messages,
  prefix = ""
): { key: string; message: string }[] {
  return Object.entries(messages).flatMap(([k, v]) =>
    typeof v === "string"
      ? [{ key: `${prefix}${k}`, message: v }]
      : flatten(v, `${prefix}${k}.`)
  );
}

type Ast = ReturnType<IntlMessageFormat["getAst"]>;
type Value = string | number | Date | ((chunks: unknown[]) => string);

// Each argument of the message with a sample value, and every value worth
// rendering it with: each select option and a few plural counts, so each
// branch that may hold a token renders at least once.
function argumentsOf(
  ast: Ast,
  out = new Map<string, Value[]>()
): Map<string, Value[]> {
  const add = (name: string, values: Value[]) => {
    const seen = out.get(name) ?? [];
    out.set(name, [...seen, ...values.filter((v) => !seen.includes(v))]);
  };
  for (const el of ast) {
    switch (el.type) {
      case 1:
        add(el.value, ["Rani"]);
        break;
      case 2:
        add(el.value, [3]);
        break;
      case 3:
      case 4:
        add(el.value, [new Date(Date.UTC(2026, 10, 21, 9, 30))]);
        break;
      case 5:
        add(el.value, Object.keys(el.options));
        for (const o of Object.values(el.options)) argumentsOf(o.value, out);
        break;
      case 6:
        add(el.value, [0, 1, 2, 5, 21]);
        for (const o of Object.values(el.options)) argumentsOf(o.value, out);
        break;
      case 8:
        add(el.value, [
          (chunks: unknown[]) =>
            `<${el.value}>${chunks.join("")}</${el.value}>`,
        ]);
        argumentsOf(el.children, out);
        break;
    }
  }
  return out;
}

// One value set per variation: every argument at its first value, then each
// argument through its other values in turn.
function variations(args: Map<string, Value[]>): Record<string, Value>[] {
  const base = Object.fromEntries(
    [...args].map(([name, values]) => [name, values[0] as Value])
  );
  const out = [base];
  for (const [name, values] of args) {
    for (const value of values.slice(1)) out.push({ ...base, [name]: value });
  }
  return out;
}

const render = (
  message: string,
  locale: string,
  values: Record<string, Value>
) => {
  const out = new IntlMessageFormat(message, locale).format(values);
  return Array.isArray(out) ? out.join("") : String(out);
};

describe("branded catalogues against ICU arguments", () => {
  for (const locale of locales) {
    it(`${locale}: every token-bearing message renders the name literally`, async () => {
      const catalogue = (await import(`../messages/${locale}.json`))
        .default as Messages;
      const entries = flatten(catalogue).filter(({ message }) =>
        TOKENS.some(([token]) => message.includes(token))
      );
      expect(entries.length).toBeGreaterThan(0);

      const mismatches: string[] = [];
      for (const appName of NAMES) {
        for (const companyName of [null, appName]) {
          const brandedMessages = applyBranding(catalogue, {
            appName,
            companyName,
            allowedEmailDomain: DOMAIN,
          });
          const brandedFlat = new Map(
            flatten(brandedMessages).map((e) => [e.key, e.message])
          );
          const brandValues = {
            brandApp: appName,
            brandCompany: companyName ?? appName,
            brandDomain: DOMAIN,
          };
          for (const { key, message } of entries) {
            let reference = message;
            for (const [token, arg] of TOKENS) {
              reference = reference.replaceAll(token, `{${arg}}`);
            }
            const args = argumentsOf(
              new IntlMessageFormat(reference, locale).getAst()
            );
            for (const name of Object.keys(brandValues)) args.delete(name);
            for (const values of variations(args)) {
              const expected = render(reference, locale, {
                ...values,
                ...brandValues,
              });
              const actual = render(brandedFlat.get(key) ?? "", locale, values);
              if (actual !== expected) {
                mismatches.push(
                  `${key} [${JSON.stringify(appName)}, company ${JSON.stringify(companyName)}]: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`
                );
              }
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
    });
  }
});
