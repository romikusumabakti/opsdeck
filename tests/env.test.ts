import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { requireEnv, validateEnv } from "@/lib/env";

// validateEnv reads process.env at call time, so each case builds the whole
// environment it wants and the original is restored afterwards.
// Typed `string[]`, not a literal tuple: Next's types mark `process.env.NODE_ENV`
// read-only, so a literal key union would make the restore loop below a
// compile error.
const MANAGED: string[] = [
  "NEXT_PHASE",
  "NODE_ENV",
  "DATABASE_URL",
  "SECRETS_KEY",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "APP_TIMEZONE",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MICROSOFT_TENANT_ID",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "IMGPROXY_URL",
  "IMGPROXY_KEY",
  "IMGPROXY_SALT",
  "RESEND_API_KEY",
  "REDIS_URL",
];

let saved: Record<string, string | undefined> = {};

// A 32-byte key, base64 — the shape lib/secrets.ts requires.
const VALID_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");

function setEnv(overrides: Record<string, string | undefined>): void {
  for (const key of MANAGED) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }
}

/** The minimum that must be present for validateEnv to pass. */
function validCore(): Record<string, string> {
  return {
    DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    SECRETS_KEY: VALID_SECRETS_KEY,
  };
}

// Every case leaves optional feature groups unset, so validateEnv warns about
// each of them. That is the intended behaviour, not test noise — silence it
// here rather than let it bury the actual test output.
const realWarn = console.warn;

beforeEach(() => {
  saved = {};
  for (const key of MANAGED) saved[key] = process.env[key];
  console.warn = () => {};
});

afterEach(() => {
  console.warn = realWarn;
  for (const key of MANAGED) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("validateEnv", () => {
  it("passes with only the core vars set", () => {
    setEnv(validCore());
    expect(() => validateEnv()).not.toThrow();
  });

  it("is a no-op during `next build`", () => {
    // Page-data collection evaluates route modules with no runtime env; a throw
    // here would fail every build.
    setEnv({ NEXT_PHASE: "phase-production-build" });
    expect(() => validateEnv()).not.toThrow();
  });

  it("reports a missing core var by name", () => {
    setEnv({ SECRETS_KEY: VALID_SECRETS_KEY });
    expect(() => validateEnv()).toThrow(/DATABASE_URL/);
  });

  it("reports every problem at once, not just the first", () => {
    setEnv({});
    let message = "";
    try {
      validateEnv();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("SECRETS_KEY");
  });

  it("rejects a SECRETS_KEY that isn't 32 bytes", () => {
    // The .env.example placeholder decodes to something, just not 32 bytes —
    // previously this surfaced at the first decrypt, inside a background job.
    setEnv({ ...validCore(), SECRETS_KEY: "CHANGE_ME" });
    expect(() => validateEnv()).toThrow(/SECRETS_KEY/);
  });

  it("rejects a DATABASE_URL with the wrong scheme", () => {
    setEnv({ ...validCore(), DATABASE_URL: "mysql://user:pass@host/db" });
    expect(() => validateEnv()).toThrow(/DATABASE_URL/);
  });

  it("rejects a malformed BETTER_AUTH_URL", () => {
    // lib/auth derives the passkey rpID and origin from it via `new URL()`.
    setEnv({ ...validCore(), BETTER_AUTH_URL: "panel.example.com" });
    expect(() => validateEnv()).toThrow(/BETTER_AUTH_URL/);
  });

  it("rejects an unknown APP_TIMEZONE", () => {
    setEnv({ ...validCore(), APP_TIMEZONE: "Mars/Olympus_Mons" });
    expect(() => validateEnv()).toThrow(/APP_TIMEZONE/);
  });

  it("accepts a real IANA timezone", () => {
    setEnv({ ...validCore(), APP_TIMEZONE: "Asia/Jakarta" });
    expect(() => validateEnv()).not.toThrow();
  });

  it("requires BETTER_AUTH_SECRET only in production", () => {
    setEnv({ ...validCore(), NODE_ENV: "development" });
    expect(() => validateEnv()).not.toThrow();

    setEnv({ ...validCore(), NODE_ENV: "production" });
    expect(() => validateEnv()).toThrow(/BETTER_AUTH_SECRET/);

    setEnv({
      ...validCore(),
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "a-sufficiently-long-signing-secret",
    });
    expect(() => validateEnv()).not.toThrow();
  });

  describe("all-or-nothing feature groups", () => {
    it("allows Microsoft sign-in to be entirely absent", () => {
      setEnv(validCore());
      expect(() => validateEnv()).not.toThrow();
    });

    it("rejects Microsoft sign-in without a tenant id", () => {
      // Without MICROSOFT_TENANT_ID better-auth falls back to the "common"
      // authority, which accepts ANY Microsoft account.
      setEnv({
        ...validCore(),
        MICROSOFT_CLIENT_ID: "client",
        MICROSOFT_CLIENT_SECRET: "secret",
      });
      expect(() => validateEnv()).toThrow(/MICROSOFT_TENANT_ID/);
    });

    it("accepts Microsoft sign-in with all three set", () => {
      setEnv({
        ...validCore(),
        MICROSOFT_CLIENT_ID: "client",
        MICROSOFT_CLIENT_SECRET: "secret",
        MICROSOFT_TENANT_ID: "tenant",
      });
      expect(() => validateEnv()).not.toThrow();
    });

    it("rejects half-configured object storage", () => {
      setEnv({
        ...validCore(),
        S3_ENDPOINT: "http://garage:3900",
        S3_BUCKET: "knowledge",
      });
      expect(() => validateEnv()).toThrow(/S3_ACCESS_KEY/);
    });

    it("rejects a non-hex imgproxy key", () => {
      // Buffer.from(s, "hex") truncates silently rather than throwing, so a
      // leftover placeholder would produce an empty signing key and images
      // would 4xx with nothing in the app logs.
      setEnv({
        ...validCore(),
        IMGPROXY_URL: "http://imgproxy:8080",
        IMGPROXY_KEY: "CHANGE_ME",
        IMGPROXY_SALT: "CHANGE_ME",
      });
      expect(() => validateEnv()).toThrow(/IMGPROXY_KEY/);
    });

    it("accepts hex imgproxy secrets", () => {
      setEnv({
        ...validCore(),
        IMGPROXY_URL: "http://imgproxy:8080",
        IMGPROXY_KEY: "a".repeat(64),
        IMGPROXY_SALT: "b".repeat(64),
      });
      expect(() => validateEnv()).not.toThrow();
    });
  });
});

describe("requireEnv", () => {
  it("returns a set value", () => {
    process.env.OPSDECK_TEST_VAR = "value";
    expect(requireEnv("OPSDECK_TEST_VAR")).toBe("value");
    delete process.env.OPSDECK_TEST_VAR;
  });

  it("throws naming the missing var", () => {
    delete process.env.OPSDECK_TEST_VAR;
    expect(() => requireEnv("OPSDECK_TEST_VAR")).toThrow(
      "OPSDECK_TEST_VAR is not set"
    );
  });
});
