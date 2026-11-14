import { describe, expect, test } from "vitest";
import { authActivityFor, clientIpFrom } from "@/lib/auth-activity";

const user = { id: "u1", email: "ana@example.com" };
const newSession = {
  user,
  session: { ipAddress: null, userAgent: null, signInMethod: "password" },
};
const base = {
  newSession: null,
  error: null,
  ip: "203.0.113.7",
  userAgent: "UA/1",
};

describe("authActivityFor", () => {
  test("logs a password sign-in", () => {
    expect(
      authActivityFor({ ...base, path: "/sign-in/email", newSession })
    ).toEqual({
      actorId: "u1",
      action: "auth.signed_in",
      entityType: "user",
      entityId: "u1",
      data: { method: "password", ip: "203.0.113.7", userAgent: "UA/1" },
    });
  });

  test("uses empty strings for an unknown ip and user agent", () => {
    expect(
      authActivityFor({
        ...base,
        ip: null,
        userAgent: null,
        path: "/sign-in/email",
        newSession,
      })?.data
    ).toEqual({ method: "password", ip: "", userAgent: "" });
  });

  test("logs the method of a second-factor, passkey and Microsoft sign-in", () => {
    const method = (path: string, params?: Record<string, string>) =>
      authActivityFor({ ...base, path, params, newSession })?.data.method;
    expect(method("/two-factor/verify-totp")).toBe("password+totp");
    expect(method("/two-factor/verify-backup-code")).toBe("password+totp");
    expect(method("/passkey/verify-authentication")).toBe("passkey");
  });

  test("logs a Microsoft callback sign-in", () => {
    expect(
      authActivityFor({
        ...base,
        path: "/callback/microsoft",
        params: { id: "microsoft" },
        newSession,
      })?.data.method
    ).toBe("microsoft");
  });

  test("logs nothing for a password step that is waiting on 2FA", () => {
    expect(authActivityFor({ ...base, path: "/sign-in/email" })).toBeNull();
  });

  test("logs a failed password sign-in without an actor", () => {
    expect(
      authActivityFor({
        ...base,
        path: "/sign-in/email",
        body: { email: "Ana@Example.COM", password: "x" },
        error: { status: 401, code: "INVALID_EMAIL_OR_PASSWORD" },
      })
    ).toEqual({
      actorId: null,
      action: "auth.sign_in_failed",
      data: {
        method: "password",
        email: "ana@example.com",
        ip: "203.0.113.7",
        userAgent: "UA/1",
        reason: "INVALID_EMAIL_OR_PASSWORD",
      },
    });
  });

  test("falls back to an unknown reason and an empty email", () => {
    expect(
      authActivityFor({
        ...base,
        path: "/sign-in/email",
        error: { status: 500 },
      })?.data
    ).toMatchObject({ email: "", reason: "unknown" });
  });

  test("logs a failed second-factor check with no email", () => {
    for (const path of [
      "/two-factor/verify-totp",
      "/two-factor/verify-backup-code",
    ]) {
      expect(
        authActivityFor({
          ...base,
          path,
          body: { code: "123456" },
          error: { status: 401, code: "INVALID_CODE" },
        })
      ).toMatchObject({
        actorId: null,
        action: "auth.sign_in_failed",
        data: { method: "password+totp", email: "", reason: "INVALID_CODE" },
      });
    }
  });

  test("does not log failed passkey or Microsoft sign-ins", () => {
    for (const path of ["/passkey/verify-authentication", "/callback/:id"]) {
      expect(
        authActivityFor({ ...base, path, error: { status: 401 } })
      ).toBeNull();
    }
  });

  test("logs two-factor disable under the session user", () => {
    expect(
      authActivityFor({
        ...base,
        path: "/two-factor/disable",
        session: { user },
      })
    ).toEqual({
      actorId: "u1",
      action: "auth.two_factor_disabled",
      entityType: "user",
      entityId: "u1",
      data: { ip: "203.0.113.7", userAgent: "UA/1" },
    });
  });

  test("logs passkey registration and removal under the session user", () => {
    for (const [path, action] of [
      ["/passkey/verify-registration", "auth.passkey_added"],
      ["/passkey/delete-passkey", "auth.passkey_removed"],
    ] as const) {
      expect(authActivityFor({ ...base, path, session: { user } })).toEqual({
        actorId: "u1",
        action,
        entityType: "user",
        entityId: "u1",
        data: { ip: "203.0.113.7", userAgent: "UA/1" },
      });
    }
  });

  test("does not log a failed passkey change or one without a session", () => {
    for (const path of [
      "/passkey/verify-registration",
      "/passkey/delete-passkey",
    ]) {
      expect(
        authActivityFor({
          ...base,
          path,
          session: { user },
          error: { status: 400 },
        })
      ).toBeNull();
      expect(authActivityFor({ ...base, path })).toBeNull();
    }
  });

  test("does not log /two-factor/enable, which only issues the secret", () => {
    expect(
      authActivityFor({
        ...base,
        path: "/two-factor/enable",
        session: { user },
      })
    ).toBeNull();
  });

  describe("enrolment confirm (verify-totp with a session, not yet enabled)", () => {
    const session = { user: { ...user, twoFactorEnabled: false } };

    test("logs two_factor_enabled and no sign-in", () => {
      expect(
        authActivityFor({
          ...base,
          path: "/two-factor/verify-totp",
          session,
          newSession: { ...newSession, session: { signInMethod: "password" } },
        })
      ).toEqual({
        actorId: "u1",
        action: "auth.two_factor_enabled",
        entityType: "user",
        entityId: "u1",
        data: { ip: "203.0.113.7", userAgent: "UA/1" },
      });
    });

    test("logs nothing for a wrong code", () => {
      expect(
        authActivityFor({
          ...base,
          path: "/two-factor/verify-totp",
          session,
          error: { status: 401, code: "INVALID_CODE" },
        })
      ).toBeNull();
    });
  });

  test("a sign-in verify-totp (no session) is unchanged", () => {
    expect(
      authActivityFor({ ...base, path: "/two-factor/verify-totp", newSession })
        ?.action
    ).toBe("auth.signed_in");
    expect(
      authActivityFor({
        ...base,
        path: "/two-factor/verify-totp",
        session: null,
        error: { status: 401, code: "INVALID_CODE" },
      })?.action
    ).toBe("auth.sign_in_failed");
  });

  test("does not log a failed two-factor change or one without a session", () => {
    const session = { user };
    expect(
      authActivityFor({
        ...base,
        path: "/two-factor/disable",
        session,
        error: { status: 400, code: "INVALID_PASSWORD" },
      })
    ).toBeNull();
    expect(
      authActivityFor({ ...base, path: "/two-factor/disable" })
    ).toBeNull();
  });

  test("ignores other paths", () => {
    expect(
      authActivityFor({
        ...base,
        path: "/sign-out",
        newSession,
        session: { user },
      })
    ).toBeNull();
    expect(
      authActivityFor({ ...base, path: "/get-session", newSession })
    ).toBeNull();
  });
});

describe("clientIpFrom", () => {
  test("prefers the first x-forwarded-for hop, then cf-connecting-ip", () => {
    expect(
      clientIpFrom(
        new Headers({
          "x-forwarded-for": "198.51.100.1, 10.0.0.2",
          "cf-connecting-ip": "203.0.113.9",
        })
      )
    ).toBe("198.51.100.1");
    expect(
      clientIpFrom(new Headers({ "cf-connecting-ip": "203.0.113.9" }))
    ).toBe("203.0.113.9");
    expect(clientIpFrom(new Headers())).toBeNull();
    expect(clientIpFrom(undefined)).toBeNull();
  });
});
