import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { securityHeaders } from "@/server/middleware/security-headers";

const app = new Hono()
  .use(securityHeaders)
  .get("/ok", (c) => c.text("ok"))
  .get("/own-csp", (c) =>
    c.text("ok", 200, { "Content-Security-Policy": "default-src 'none'" })
  )
  .get("/boom", () => {
    throw new Error("boom");
  });

describe("securityHeaders", () => {
  it("locks scripts to the app's own origin, plus WebAssembly", async () => {
    const res = await app.request("/ok");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("also lands on error responses", async () => {
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src");
  });

  it("does not overwrite a route's own Content-Security-Policy", async () => {
    const res = await app.request("/own-csp");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'"
    );
    // The other headers still land.
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
