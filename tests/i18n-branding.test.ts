import { createTranslator } from "use-intl/core";
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
    const messages = applyBranding(
      { k: "a {{APP_NAME}} b {{COMPANY_NAME}} c {{EMAIL_DOMAIN}} d" },
      { appName: value, companyName: value, allowedEmailDomain: value }
    );
    expect(createTranslator({ locale: "en", messages })("k")).toBe(
      `a ${value} b ${value} c ${value} d`
    );
  });

  // The values are admin input, inserted into ICU message strings before
  // use-intl formats them: ICU syntax in a name must render literally.
  describe("with ICU syntax in the name", () => {
    const name = "Ops {x} 'y' #1 <b>";
    const messages = applyBranding(
      {
        plain: "Welcome to {{APP_NAME}}",
        possessive: "{{APP_NAME}}'s key, by {{COMPANY_NAME}}",
        argument: "{user} joined {{APP_NAME}}",
        plural:
          "{count, plural, one {# change in {{APP_NAME}}} other {# changes in {{APP_NAME}}}}",
        select:
          "{kind, select, auto {{{APP_NAME}} did it} other {{who} did it in {{APP_NAME}}}}",
        rich: "Signed in to <b>{{APP_NAME}}</b>",
      },
      { appName: name, companyName: null, allowedEmailDomain: "example.com" }
    );
    const t = createTranslator({ locale: "en", messages });

    it("renders a plain message literally", () => {
      expect(t("plain")).toBe(`Welcome to ${name}`);
      expect(t("possessive")).toBe(`${name}'s key, by ${name}`);
      expect(t("argument", { user: "Rani" })).toBe(`Rani joined ${name}`);
    });

    it("renders a plural message literally, keeping # as the count only outside the name", () => {
      expect(t("plural", { count: 1 })).toBe(`1 change in ${name}`);
      expect(t("plural", { count: 3 })).toBe(`3 changes in ${name}`);
    });

    it("renders a select message literally", () => {
      expect(t("select", { kind: "auto", who: "x" })).toBe(`${name} did it`);
      expect(t("select", { kind: "manual", who: "Rani" })).toBe(
        `Rani did it in ${name}`
      );
    });

    it("renders a rich message literally", () => {
      expect(t.markup("rich", { b: (chunks) => `[${chunks}]` })).toBe(
        `Signed in to [${name}]`
      );
    });

    it("keeps names without ICU syntax byte-identical", () => {
      expect(
        applyBranding("{count, plural, other {# in {{APP_NAME}}}}", {
          appName: ["Acme", "Panel"].join(" "),
          companyName: null,
          allowedEmailDomain: "example.com",
        })
      ).toBe("{count, plural, other {# in Acme Panel}}");
    });
  });
});
