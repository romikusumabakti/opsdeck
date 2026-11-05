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

  for (const locale of locales) {
    it(`${locale} has the held status label and saveLock`, () => {
      const m = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));
      expect(String(m.deploys.status.held).trim().length).toBeGreaterThan(0);
      expect(
        String(lockMessages(locale).saveLock).trim().length
      ).toBeGreaterThan(0);
    });
  }

  it("id is translated, not a copy of en", () => {
    const id = lockMessages("id");
    for (const key of Object.keys(en)) {
      expect(id[key], key).not.toBe(en[key]);
    }
  });
});

describe("lock dialog description", () => {
  it("tells that queued manual deploys and rollbacks are cancelled and queued builds held", () => {
    const text = lockMessages("en").dialogDescription;
    expect(text).toMatch(/queued manual deploys and rollbacks are cancelled/i);
    expect(text).toMatch(/held/);
  });
});
