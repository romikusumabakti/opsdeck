import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locales } from "@/i18n/locales";

const KEYS = [
  "deployTargetCreated",
  "deployTargetUpdated",
  "deployTargetDeleted",
] as const;

function activityMessages(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")).activity;
}

describe("deploy target activity messages", () => {
  const en = activityMessages("en");

  for (const locale of locales) {
    it(`${locale} renders every deploy target event with its params`, () => {
      const own = activityMessages(locale);
      for (const key of KEYS) {
        const text = own[key] ?? "";
        expect(text, key).toContain("{actor}");
        expect(text, key).toContain("{component}");
        expect(text, key).toContain("{environment}");
      }
      expect(own.deployTargetUpdated).toContain("{changes}");
    });
  }

  it("id is translated, not a copy of en", () => {
    const id = activityMessages("id");
    for (const key of KEYS) expect(id[key], key).not.toBe(en[key]);
  });

  it("the activity page renders the three actions", () => {
    const page = readFileSync(
      "web/routes/$locale/_app/admin.activity.tsx",
      "utf8"
    );
    for (const action of [
      "deployTarget.created",
      "deployTarget.updated",
      "deployTarget.deleted",
    ]) {
      expect(page).toContain(`case "${action}"`);
    }
  });
});
