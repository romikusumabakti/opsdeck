import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locales } from "@/i18n/locales";

type Catalog = {
  actionErrors: Record<string, string>;
  projectSources: Record<string, string>;
  activity: Record<string, string>;
};

function catalog(locale: string): Catalog {
  return JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));
}

const ERROR_KEYS = ["sourceInUse", "componentNotInSources"] as const;
const SOURCE_KEYS = ["addedSuccess", "removedSuccess", "branchSaved"] as const;

const ACTIVITY_KEYS = [
  "projectSourceAdded",
  "projectSourceRemoved",
  "projectDefaultBranchSet",
  "projectDefaultBranchChanged",
] as const;

describe("project sources messages", () => {
  const en = catalog("en");

  for (const locale of locales) {
    it(`${locale} has every refusal and success message`, () => {
      const own = catalog(locale);
      for (const key of ERROR_KEYS) {
        expect(own.actionErrors[key]?.trim(), key).toBeTruthy();
      }
      for (const key of SOURCE_KEYS) {
        expect(own.projectSources[key]?.trim(), key).toBeTruthy();
      }
    });
  }

  for (const locale of locales) {
    it(`${locale} has the activity feed sentences`, () => {
      const { activity } = catalog(locale);
      for (const key of ACTIVITY_KEYS) {
        expect(activity[key], key).toContain("{actor}");
        expect(activity[key], key).toContain("{project}");
      }
      expect(activity.projectDefaultBranchChanged).toContain("{from}");
      expect(activity.projectDefaultBranchChanged).toContain("{to}");
    });
  }

  it("the activity page renders the three project source actions", () => {
    const page = readFileSync(
      "web/routes/$locale/_app/admin.activity.tsx",
      "utf8"
    );
    for (const action of [
      "project.sourceAdded",
      "project.sourceRemoved",
      "project.defaultBranchChanged",
    ]) {
      expect(page).toContain(`case "${action}"`);
    }
  });

  it("id is translated, not a copy of en", () => {
    const id = catalog("id");
    for (const key of ERROR_KEYS) {
      expect(id.actionErrors[key], key).not.toBe(en.actionErrors[key]);
    }
    for (const key of SOURCE_KEYS) {
      expect(id.projectSources[key], key).not.toBe(en.projectSources[key]);
    }
  });
});
