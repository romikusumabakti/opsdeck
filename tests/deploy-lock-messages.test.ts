import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locales } from "@/i18n/locales";

function lockMessages(locale: string): Record<string, string> {
  const m = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));
  return m.deploys.lock;
}

describe("deploy lock messages", () => {
  const en = lockMessages("en");

  for (const locale of locales) {
    it(`${locale} has every deploys.lock key, non-empty`, () => {
      const own = lockMessages(locale);
      expect(Object.keys(own).sort()).toEqual(Object.keys(en).sort());
      for (const [key, value] of Object.entries(own)) {
        expect(value.trim().length, key).toBeGreaterThan(0);
      }
    });
  }

  it("id is translated, not a copy of en", () => {
    const id = lockMessages("id");
    for (const key of Object.keys(en)) {
      expect(id[key], key).not.toBe(en[key]);
    }
  });
});
