import { describe, expect, it } from "vitest";
import {
  localeFromCookie,
  localeFromLanguages,
} from "@/i18n/locale-preference";

describe("localeFromCookie", () => {
  it.each([
    ["NEXT_LOCALE=id", "id"],
    ["theme=dark; NEXT_LOCALE=zh; other=1", "zh"],
    [" NEXT_LOCALE = ar ", "ar"],
  ])("reads %s", (header, locale) => {
    expect(localeFromCookie(header)).toBe(locale);
  });

  it.each([
    [null],
    [""],
    ["NEXT_LOCALE=fr"],
    ["NOT_NEXT_LOCALE=id"],
    ["theme=dark"],
  ])("finds no locale in %s", (header) => {
    expect(localeFromCookie(header)).toBeUndefined();
  });
});

describe("localeFromLanguages", () => {
  it("takes the first supported primary subtag", () => {
    expect(localeFromLanguages(["fr-FR", "zh-TW", "en"])).toBe("zh");
  });

  it("finds nothing in unsupported languages", () => {
    expect(localeFromLanguages(["fr", "de"])).toBeUndefined();
  });
});
