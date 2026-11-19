import { readFileSync } from "node:fs";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { locales } from "@/i18n/locales";

// The wording of the Assistant's database queries outside the tools: the
// activity entry (assistant.databaseQuery) and the answer's "Panel data"
// labels, in every locale.

type Messages = Record<string, Record<string, unknown>>;
const messages = (locale: string): Messages =>
  JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));

const CASES = [
  { outcome: "ok", reason: "", rows: 3 },
  { outcome: "ok", reason: "", rows: 1 },
  { outcome: "refused", reason: "notEnabled", rows: 0 },
  { outcome: "refused", reason: "multiple", rows: 0 },
  { outcome: "refused", reason: "not_select", rows: 0 },
  { outcome: "refused", reason: "wrapped_sensitive", rows: 0 },
  { outcome: "refused", reason: "parse", rows: 0 },
  { outcome: "refused", reason: "limit", rows: 0 },
  { outcome: "failed", reason: "", rows: 0 },
];

describe("assistant database query messages", () => {
  for (const locale of locales) {
    it(`${locale} words the activity entry for every outcome and the read labels`, () => {
      const m = messages(locale);
      const text = m.activity?.assistantDatabaseQuery;
      expect(typeof text).toBe("string");
      const format = new IntlMessageFormat(String(text), locale);
      const seen = new Set<string>();
      for (const c of CASES) {
        const out = String(
          format.format({
            actor: "Rani",
            environment: "Acme / QA",
            sql: "SELECT id FROM orders WHERE total > ?",
            ...c,
          })
        );
        expect(out).toContain("SELECT id FROM orders WHERE total > ?");
        expect(out).toContain("Acme / QA");
        seen.add(out);
      }
      // Every outcome and refusal reason reads differently.
      expect(seen.size).toBe(CASES.length);
      for (const key of ["panelListTables", "panelQueryDatabase"]) {
        const label = m.assistant?.[key];
        expect(typeof label, key).toBe("string");
        expect(String(label).trim(), key).not.toBe("");
      }
    });
  }

  it("the activity page renders assistant.databaseQuery", () => {
    const page = readFileSync(
      "web/routes/$locale/_app/admin.activity.tsx",
      "utf8"
    );
    expect(page).toMatch(
      /case "assistant\.databaseQuery":\s*return t\("assistantDatabaseQuery"/
    );
  });

  it("an answer lists its database reads under Panel data", () => {
    const view = readFileSync(
      "web/components/assistant/message-sources.tsx",
      "utf8"
    );
    expect(view).toContain('list_tables: "panelListTables"');
    expect(view).toContain('query_database: "panelQueryDatabase"');
  });
});
