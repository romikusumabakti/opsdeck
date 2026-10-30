import { describe, expect, it } from "vitest";
import { getServerSession, requireSession } from "@/lib/auth-session";
import { app, createBaseApp } from "@/server/app";
import { getLocale } from "@/server/context";

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), interest-cohort=(), publickey-credentials-get=(self)",
};

describe("server app", () => {
  it("answers the health check", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });

  it("sets every security header and does not advertise the framework", async () => {
    const res = await app.request("/api/health");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
    expect(res.headers.has("x-powered-by")).toBe(false);
  });

  it("serves better-auth under /api/auth", async () => {
    const res = await app.request("/api/auth/get-session");
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});

describe("shared middleware", () => {
  const probe = createBaseApp()
    .get("/session", async (c) => c.json(await requireSession()))
    .get("/locale", (c) => c.text(getLocale()));

  it("turns a missing session into a 401 JSON error", async () => {
    const res = await probe.request("/session");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    // Error responses carry the security headers too.
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it.each([
    [{ "X-Locale": "id" }, "id"],
    [{ "Accept-Language": "ar,en;q=0.8" }, "ar"],
    [{ "X-Locale": "xx" }, "en"],
  ])("resolves the locale from %o", async (headers, expected) => {
    const res = await probe.request("/locale", { headers });
    expect(await res.text()).toBe(expected);
  });
});

describe("outside a request", () => {
  it("falls back to the default locale", () => {
    expect(getLocale()).toBe("en");
  });

  it("has no session", async () => {
    expect(await getServerSession()).toBeNull();
  });
});
