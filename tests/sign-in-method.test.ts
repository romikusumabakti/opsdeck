import { describe, expect, it } from "vitest";
import {
  isStrongSignIn,
  signInMethodFor,
  signInMethodForRotation,
} from "@/lib/sign-in-method";

describe("signInMethodForRotation", () => {
  it("keeps a strong method when a new authenticator is confirmed", () => {
    for (const method of ["passkey", "microsoft", "password+totp"]) {
      expect(signInMethodForRotation("/two-factor/verify-totp", method)).toBe(
        method
      );
    }
  });

  it("upgrades a weak session that confirms an authenticator", () => {
    expect(signInMethodForRotation("/two-factor/verify-totp", "password")).toBe(
      "password+totp"
    );
    expect(signInMethodForRotation("/two-factor/verify-totp", null)).toBe(
      "password+totp"
    );
  });

  it("keeps the method on disable, except password+totp which drops to password", () => {
    expect(signInMethodForRotation("/two-factor/disable", "passkey")).toBe(
      "passkey"
    );
    expect(signInMethodForRotation("/two-factor/disable", "microsoft")).toBe(
      "microsoft"
    );
    expect(signInMethodForRotation("/two-factor/disable", "password")).toBe(
      "password"
    );
    expect(
      signInMethodForRotation("/two-factor/disable", "password+totp")
    ).toBe("password");
    expect(signInMethodForRotation("/two-factor/disable", null)).toBeNull();
  });

  it("is undefined for other paths", () => {
    expect(
      signInMethodForRotation("/sign-in/email", "passkey")
    ).toBeUndefined();
  });
});

describe("signInMethodFor", () => {
  it("maps the password endpoint to password", () => {
    expect(signInMethodFor("/sign-in/email")).toBe("password");
  });

  it("maps both second-factor endpoints to password+totp", () => {
    expect(signInMethodFor("/two-factor/verify-totp")).toBe("password+totp");
    expect(signInMethodFor("/two-factor/verify-backup-code")).toBe(
      "password+totp"
    );
  });

  it("counts passkey authentication but not passkey registration", () => {
    expect(signInMethodFor("/passkey/verify-authentication")).toBe("passkey");
    expect(signInMethodFor("/passkey/verify-registration")).toBeNull();
  });

  it("counts only the Microsoft callback", () => {
    expect(signInMethodFor("/callback/:id", { id: "microsoft" })).toBe(
      "microsoft"
    );
    expect(signInMethodFor("/callback/:id", { id: "github" })).toBeNull();
  });

  it("ignores paths that are not sign-ins", () => {
    expect(signInMethodFor("/admin/impersonate-user")).toBeNull();
    expect(signInMethodFor("/sign-in/social")).toBeNull();
    expect(signInMethodFor("/change-password")).toBeNull();
    expect(signInMethodFor("")).toBeNull();
  });
});

describe("isStrongSignIn", () => {
  it("accepts the three strong methods", () => {
    for (const m of ["password+totp", "passkey", "microsoft"]) {
      expect(isStrongSignIn(m)).toBe(true);
    }
  });

  it("rejects password, missing and unknown values", () => {
    for (const m of ["password", null, undefined, "bogus"]) {
      expect(isStrongSignIn(m)).toBe(false);
    }
  });
});
