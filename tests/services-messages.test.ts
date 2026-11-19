import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locales } from "@/i18n/locales";

// The Services UI (Stage 8) in every locale: the serviceCatalog namespace
// and the strings its pages, the New environment service picker and the
// template conflict picker add elsewhere, each with en's placeholders.

type Node = Record<string, unknown>;

function messages(locale: string): Node {
  return JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));
}

function leaves(node: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      for (const [k, v] of leaves(value, path)) out.set(k, v);
    }
  } else {
    out.set(prefix, String(node));
  }
  return out;
}

// An argument is `{name}` or `{name, plural, …}`; a plural branch's text
// (`{# projects}`, `{Service registered}`) is not.
const placeholders = (text: string) =>
  [
    ...new Set([...text.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => m[1])),
  ].sort();

const SHARED_KEYS = [
  "nav.serviceCatalog",
  "breadcrumbs.serviceCatalog",
  "variableTemplates.description",
  "deploys.serviceRepo",
  "newEnvironment.services",
  "newEnvironment.servicesHint",
  "newEnvironment.addService",
  "newEnvironment.searchServices",
  "newEnvironment.noServices",
  "newEnvironment.removeService",
  "newEnvironment.deployDir",
  "projectSources.addService",
  "projectSources.addServiceTitle",
  "projectSources.selectService",
  "projectSources.noServicesToAdd",
  "variables.conflicts.title",
  "variables.conflicts.description",
  "variables.conflicts.escrowNote",
  "variables.conflicts.fill",
  "variables.conflicts.skip",
];

// Keys the Services rename retired; nothing may still read them.
const RETIRED_KEYS = [
  "apps",
  "nav.repositories",
  "breadcrumbs.repositories",
  "variableTemplates.subtitle",
  "projectSources.addApp",
  "deploys.form.otherApp",
  "deploys.form.componentKey",
  "newEnvironment.repository",
  "newEnvironment.chooseRepo",
];

describe("services messages", () => {
  const en = messages("en");
  const enAll = leaves(en);
  const enCatalog = leaves(en.serviceCatalog);

  for (const locale of locales) {
    it(`${locale} has every serviceCatalog key with en's placeholders`, () => {
      const own = leaves(messages(locale).serviceCatalog);
      expect([...own.keys()].sort()).toEqual([...enCatalog.keys()].sort());
      for (const [key, value] of own) {
        expect(value.trim().length, key).toBeGreaterThan(0);
        expect(placeholders(value), key).toEqual(
          placeholders(enCatalog.get(key) ?? "")
        );
      }
    });

    it(`${locale} has the shared keys with en's placeholders`, () => {
      const all = leaves(messages(locale));
      for (const key of SHARED_KEYS) {
        const value = all.get(key) ?? "";
        expect(value.trim().length, key).toBeGreaterThan(0);
        expect(placeholders(value), key).toEqual(
          placeholders(enAll.get(key) ?? "")
        );
      }
      for (const key of RETIRED_KEYS) {
        expect(
          [...all.keys()].some((k) => k === key || k.startsWith(`${key}.`)),
          key
        ).toBe(false);
      }
    });
  }
});
