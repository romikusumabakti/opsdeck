import { readFileSync } from "node:fs";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { applyBranding, type Branding } from "@/i18n/branding";
import { locales } from "@/i18n/locales";

// The UI calls the product by the instance's own name (`{{APP_NAME}}`), never
// "Panel" or a localized generic word for it, and every message still
// compiles as ICU with any name in it.

type Tree = { [key: string]: Tree | string };

const catalogue = (locale: string): Tree =>
  JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const flat = Object.fromEntries(
  locales.map((locale) => [locale, flatten(catalogue(locale))])
) as Record<string, Map<string, string>>;

const en = flat.en as Map<string, string>;

// Two instance names: the default one and a two-word one.
const NAMES = ["Menara", ["Acme", "Panel"].join(" ")];

type Ast = ReturnType<IntlMessageFormat["getAst"]>;

// Every argument a message reads, and every tag it wraps.
function collect(ast: Ast, args: Set<string>, tags: Set<string>) {
  for (const el of ast) {
    if (el.type === 8) {
      tags.add(el.value);
      collect(el.children, args, tags);
    } else if (el.type === 5 || el.type === 6) {
      args.add(el.value);
      for (const option of Object.values(el.options)) {
        collect(option.value, args, tags);
      }
    } else if (el.type !== 0 && el.type !== 7) {
      args.add(el.value);
    }
  }
}

function formatWith(message: string, locale: string): unknown {
  const format = new IntlMessageFormat(message, locale);
  const args = new Set<string>();
  const tags = new Set<string>();
  collect(format.getAst(), args, tags);
  const values: Record<string, unknown> = {};
  for (const arg of args) values[arg] = 1;
  for (const tag of tags) values[tag] = (chunks: unknown[]) => chunks.join("");
  return format.format(values as never);
}

// The step name `notify-panel` is still named, as the accepted old name.
const withoutStepName = (s: string) =>
  s.replaceAll("notify-menara", "").replaceAll("notify-panel", "");

// es: "panel" is also the ordinary word for a dashboard (ours and
// Cloudflare's), not the product.
const ES_DASHBOARD_KEYS = [
  "cloudflareAccount.accountIdDescription",
  "dashboard.title",
  "nav.dashboard",
  "services.logs.backToDashboard",
  "zoneForm.zoneIdDescription",
];

// zh: 面板 only inside 命令面板 (the command palette).
const ZH_COMMAND_PALETTE_KEYS = [
  "commandPalette.title",
  "shortcuts.openCommandPalette",
];

// ar: لوحة (also as اللوح / للوح) for the command palette, the keyboard, a
// dashboard (ours and Cloudflare's) and the issues board — never the product.
const AR_LAWHA_KEYS = [
  "cloudflareAccount.accountIdDescription",
  "commandPalette.title",
  "dashboard.title",
  "issues.viewBoard",
  "nav.dashboard",
  "services.logs.backToDashboard",
  "shortcuts.openCommandPalette",
  "shortcuts.title",
  "zoneForm.zoneIdDescription",
];

const OLD_KEYS = [
  "history.byAutoPanelUser",
  "environmentSettings.removeFromPanel",
  "environmentSettings.removeFromPanelDescription",
  "environmentSettings.removedFromPanel",
  "variables.envPreview.panelWritten",
  "assistant.panelRead",
  "assistant.openPanelIssue",
];

const NEW_KEYS = [
  "history.byAutoAppUser",
  "environmentSettings.removeFromApp",
  "environmentSettings.removeFromAppDescription",
  "environmentSettings.removedFromApp",
  "variables.envPreview.appWritten",
  "assistant.appData",
  "assistant.openAppIssue",
];

describe("messages name the product by the instance name", () => {
  it("every locale has the same keys as en", () => {
    for (const locale of locales) {
      const keys = [...(flat[locale] as Map<string, string>).keys()].sort();
      expect(keys, locale).toEqual([...en.keys()].sort());
    }
  });

  it("every message compiles as ICU and formats with both instance names", () => {
    const failures: string[] = [];
    for (const locale of locales) {
      for (const [key, raw] of flat[locale] as Map<string, string>) {
        for (const appName of NAMES) {
          const branding: Branding = {
            appName,
            companyName: null,
            allowedEmailDomain: "example.com",
          };
          try {
            formatWith(applyBranding(raw, branding), locale);
          } catch (error) {
            failures.push(`${locale} ${key} (${appName}): ${error}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("no message names the product Panel", () => {
    const hits: string[] = [];
    for (const locale of locales) {
      for (const [key, value] of flat[locale] as Map<string, string>) {
        if (locale === "es" && ES_DASHBOARD_KEYS.includes(key)) continue;
        if (/\bpanel\b/i.test(withoutStepName(value))) {
          hits.push(`${locale} ${key}: ${value}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("zh uses 面板 only in 命令面板", () => {
    const hits: string[] = [];
    for (const [key, value] of flat.zh as Map<string, string>) {
      const rest = ZH_COMMAND_PALETTE_KEYS.includes(key)
        ? value.replaceAll("命令面板", "")
        : value;
      if (rest.includes("面板")) hits.push(`${key}: ${value}`);
    }
    expect(hits).toEqual([]);
    for (const key of ZH_COMMAND_PALETTE_KEYS) {
      expect(flat.zh?.get(key), key).toContain("命令面板");
    }
  });

  it("ar uses لوحة only in the command palette strings", () => {
    const hits: string[] = [];
    for (const [key, value] of flat.ar as Map<string, string>) {
      if (AR_LAWHA_KEYS.includes(key)) continue;
      if (/لوحة|اللوح|للوح/.test(value)) hits.push(`${key}: ${value}`);
    }
    expect(hits).toEqual([]);
    for (const key of [
      "commandPalette.title",
      "shortcuts.openCommandPalette",
    ]) {
      expect(flat.ar?.get(key), key).toContain("لوحة الأوامر");
    }
  });

  it("no article or contraction right before the instance name", () => {
    const rules: Record<string, RegExp> = {
      en: /\b(the|a|an)\s+\{\{APP_NAME\}\}/i,
      es: /\b(el|al|del|la|los)\s+\{\{APP_NAME\}\}/i,
      id: /\bpanel\s+\{\{APP_NAME\}\}/i,
    };
    const hits: string[] = [];
    for (const [locale, rule] of Object.entries(rules)) {
      for (const [key, value] of flat[locale] as Map<string, string>) {
        if (rule.test(value)) hits.push(`${locale} ${key}: ${value}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("names the notify-menara step", () => {
    for (const locale of locales) {
      expect(
        flat[locale]?.get("newEnvironment.pipelineNotNotifying"),
        locale
      ).toContain("notify-menara");
    }
  });

  it("no old panel key remains", () => {
    for (const locale of locales) {
      const keys = flat[locale] as Map<string, string>;
      for (const key of OLD_KEYS)
        expect(keys.has(key), `${locale} ${key}`).toBe(false);
      for (const key of NEW_KEYS)
        expect(keys.has(key), `${locale} ${key}`).toBe(true);
    }
  });
});
