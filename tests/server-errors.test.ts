import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { createBaseApp } from "@/server/app";

describe("onError", () => {
  it("answers a CSRF rejection with the status text, not HTTP 403", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    try {
      const app = createBaseApp().post("/api/x", (c) => c.json({ ok: true }));
      const res = await app.request("http://localhost:3000/api/x", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "a=1",
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps an HTTPException's own message", async () => {
    const app = createBaseApp().get("/api/x", () => {
      throw new HTTPException(409, { message: "Already exists" });
    });
    const res = await app.request("/api/x");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Already exists" });
  });

  it("falls back to the status text for any messageless status", async () => {
    const app = createBaseApp().get("/api/x", () => {
      throw new HTTPException(413);
    });
    const res = await app.request("/api/x");
    expect(await res.json()).toEqual({ error: "Payload Too Large" });
  });
});
