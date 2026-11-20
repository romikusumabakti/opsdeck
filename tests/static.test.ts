import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { InstanceBranding } from "@/lib/instance-branding";

const DEFAULT_BRANDING: InstanceBranding = {
  name: "Menara",
  company: null,
  accent: "neutral",
  logo: null,
  logoDark: null,
  version: "0",
};

vi.mock("@/lib/instance-branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instance-branding")>()),
  getBranding: vi.fn(async () => DEFAULT_BRANDING),
}));

const { createBaseApp } = await import("@/server/app");
const { brandShell, mountStatic } = await import("@/server/static");

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><link rel="icon" href="/brand/icon.svg" type="image/svg+xml" /><title>Menara</title></head><div id="root"></div></html>';
// INDEX_HTML as served with the default branding.
const BRANDED_HTML =
  '<!doctype html><html data-accent="neutral" lang="en"><head><link rel="icon" href="/brand/icon.svg" type="image/svg+xml" /><title>Menara</title></head><div id="root"></div></html>';

let dir: string;
let clientDir: string;
let publicDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "menara-static-"));
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
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(await res.text()).toBe(BRANDED_HTML);
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

  it("redirects to the NEXT_LOCALE cookie's locale", async () => {
    const res = await app().request("/servers", {
      headers: { Cookie: "theme=dark; NEXT_LOCALE=id" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/id/servers");
  });

  it("falls back to Accept-Language without a cookie", async () => {
    const res = await app().request("/servers", {
      headers: { "Accept-Language": "ar" },
    });
    expect(res.headers.get("location")).toBe("/ar/servers");
  });

  it("ignores an invalid NEXT_LOCALE cookie", async () => {
    const withLanguage = await app().request("/servers", {
      headers: {
        Cookie: "NEXT_LOCALE=fr",
        "Accept-Language": "es-MX,en;q=0.5",
      },
    });
    expect(withLanguage.headers.get("location")).toBe("/es/servers");
    const bare = await app().request("/servers", {
      headers: { Cookie: "NEXT_LOCALE=fr" },
    });
    expect(bare.headers.get("location")).toBe("/en/servers");
  });

  it("keeps the cookie from overriding a path's own locale", async () => {
    const res = await app().request("/es/servers", {
      headers: { Cookie: "NEXT_LOCALE=id" },
    });
    expect(res.status).toBe(200);
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

  it("revalidates index.html requested by name, branded", async () => {
    const res = await app().request("/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(BRANDED_HTML);
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

describe("brandShell", () => {
  const branding = (over: Partial<InstanceBranding>): InstanceBranding => ({
    ...DEFAULT_BRANDING,
    ...over,
  });

  it("puts the instance name, accent and favicon into the shell", () => {
    expect(
      brandShell(INDEX_HTML, branding({ name: "Acme Ops", accent: "blue" }))
    ).toBe(
      '<!doctype html><html data-accent="blue" lang="en"><head><link rel="icon" href="/brand/icon.svg" type="image/svg+xml" /><title>Acme Ops</title></head><div id="root"></div></html>'
    );
  });

  it("links a stored SVG logo as the favicon, versioned", () => {
    expect(
      brandShell(
        INDEX_HTML,
        branding({ logo: { type: "image/svg+xml" }, version: "kx1" })
      )
    ).toContain(
      '<link rel="icon" href="/brand/icon.svg?v=kx1" type="image/svg+xml" />'
    );
  });

  it("HTML-escapes the app name", () => {
    expect(
      brandShell(
        INDEX_HTML,
        branding({ name: '</title><script>alert("x")</script>&' })
      )
    ).toContain(
      "<title>&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;</title>"
    );
  });
});
