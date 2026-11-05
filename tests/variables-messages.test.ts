import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locales } from "@/i18n/locales";

type Messages = Record<string, unknown>;

function messages(locale: string): Messages {
  return JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));
}

function leaves(node: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      for (const [k, v] of leaves(value, path)) out.set(k, v);
    }
  } else {
    out.set(prefix, node);
  }
  return out;
}

// Keys outside the variables namespaces that the feature adds.
const SHARED_KEYS = [
  "nav.variables",
  "breadcrumbs.variables",
  "apps.variableTemplates",
  "activity.variablesRevealed",
  "activity.variableCreated",
  "activity.variableUpdated",
  "activity.variableDeleted",
  "activity.variableRegenerated",
  "activity.variableEscrowRemoved",
  "activity.envFileManagedOn",
  "activity.envFileManagedOff",
  "activity.variablesTemplateApplied",
  "activity.variableTemplateSaved",
  "activity.variableTemplateDeleted",
  "activity.environmentDeletedWithVariables",
  "actionErrors.environmentHasEscrowedVariables",
  "actionErrors.placementServiceName",
  "environmentSettings.deleteEscrowedTitle",
  "environmentSettings.deleteEscrowedDescription",
];

describe("variables messages", () => {
  for (const ns of ["variables", "variableTemplates"]) {
    const en = leaves(messages("en")[ns]);
    it(`en defines ${ns}`, () => {
      expect(en.size).toBeGreaterThan(0);
    });
    for (const locale of locales) {
      it(`${locale} has the same ${ns} keys as en, all non-empty`, () => {
        const own = leaves(messages(locale)[ns]);
        expect([...own.keys()].sort()).toEqual([...en.keys()].sort());
        for (const [key, value] of own) {
          expect(typeof value, key).toBe("string");
          expect(String(value).trim().length, key).toBeGreaterThan(0);
        }
      });
    }
  }
  for (const locale of locales) {
    it(`${locale} has the shared keys`, () => {
      const all = leaves(messages(locale));
      for (const key of SHARED_KEYS) {
        expect(String(all.get(key) ?? "").trim().length, key).toBeGreaterThan(
          0
        );
      }
    });
  }
});
