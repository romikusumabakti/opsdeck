import { describe, expect, it, vi } from "vitest";

describe("GET /api/health", () => {
  it("reports ok and the version baked into the image", async () => {
    vi.stubEnv("OPSDECK_VERSION", "1.4.0-beta.2");
    vi.resetModules();
    const { app } = await import("@/server/app");
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "1.4.0-beta.2" });
  });
});
