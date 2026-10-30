import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBaseApp } from "@/server/app";
import { mountStatic } from "@/server/static";

const INDEX_HTML = '<!doctype html><div id="root"></div>';

let dir: string;
let clientDir: string;
let publicDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "opsdeck-static-"));
  clientDir = join(dir, "dist/client");
  publicDir = join(dir, "public");
  mkdirSync(join(clientDir, "assets"), { recursive: true });
  mkdirSync(join(publicDir, "motifs"), { recursive: true });
  writeFileSync(join(clientDir, "index.html"), INDEX_HTML);
  writeFileSync(join(clientDir, "assets/index-abc.js"), "console.log(1)");
  writeFileSync(join(publicDir, "motifs/kawung.svg"), "<svg/>");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function prodApp() {
  vi.stubEnv("NODE_ENV", "production");
  try {
    const app = createBaseApp().get("/api/health", (c) => c.json({ ok: true }));
    mountStatic(app, { clientDir, publicDir });
    return app;
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("production static serving", () => {
  const app = () => prodApp();

  // A refresh on a deep link must get the SPA, with the same security headers
  // as every API response.
  it("answers a deep link with index.html and the security headers", async () => {
    const res = await app().request("/en/servers/x");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'"
    );
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("answers an unknown API path with a JSON 404, never the SPA", async () => {
    const res = await app().request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });

  it("still serves the API", async () => {
    const res = await app().request("/api/health");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("redirects a path with no locale, keeping the query", async () => {
    const res = await app().request("/servers?tab=usage");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/en/servers?tab=usage");
  });

  it("redirects the root to the default locale", async () => {
    const res = await app().request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/en");
  });

  it("redirects a non-canonical project path permanently", async () => {
    const res = await app().request("/en/tmem/DEV");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/en/TMEM/dev");
  });

  it("serves hashed assets as immutable", async () => {
    const res = await app().request("/assets/index-abc.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers a missing asset with 404, not the SPA", async () => {
    const res = await app().request("/assets/missing.js");
    expect(res.status).toBe(404);
  });

  it("answers a /brand miss with 404, not the SPA", async () => {
    const res = await app().request("/brand/nope.png");
    expect(res.status).toBe(404);
  });

  it("revalidates index.html requested by name", async () => {
    const res = await app().request("/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("serves files from public/", async () => {
    const res = await app().request("/motifs/kawung.svg");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<svg/>");
  });
});

describe("static serving outside production", () => {
  it("leaves pages to the Vite dev server", async () => {
    const app = createBaseApp();
    mountStatic(app, { clientDir, publicDir });
    const res = await app.request("/en/servers");
    expect(res.status).toBe(404);
  });
});
