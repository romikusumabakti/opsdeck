import { describe, expect, it } from "vitest";
import { applyBranding } from "@/i18n/branding";

describe("applyBranding", () => {
  it("replaces the tokens, with the company falling back to the name", () => {
    expect(
      applyBranding(
        { a: "{{APP_NAME}} by {{COMPANY_NAME}}", b: ["@{{EMAIL_DOMAIN}}"] },
        { appName: "Acme", companyName: null, allowedEmailDomain: "acme.test" }
      )
    ).toEqual({ a: "Acme by Acme", b: ["@acme.test"] });
  });

  it("inserts admin-set values literally, never as replacement patterns", () => {
    const value = "x $& $' $` $1 $$ y";
    expect(
      applyBranding("a {{APP_NAME}} b {{COMPANY_NAME}} c {{EMAIL_DOMAIN}} d", {
        appName: value,
        companyName: value,
        allowedEmailDomain: value,
      })
    ).toBe(`a ${value} b ${value} c ${value} d`);
  });
});
