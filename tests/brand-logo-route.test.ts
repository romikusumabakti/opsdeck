import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceBranding, LogoType } from "@/lib/instance-branding";

type Stored = { bytes: Uint8Array; type: LogoType };

const state = vi.hoisted(() => ({
  branding: null as unknown as InstanceBranding,
  logos: {} as Partial<Record<"light" | "dark", Stored>>,
  loads: 0,
}));

vi.mock("@/lib/instance-branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instance-branding")>()),
  getBranding: vi.fn(async () => state.branding),
  getBrandLogoBytes: vi.fn(async (theme: "light" | "dark") => {
    state.loads += 1;
    return state.logos[theme] ?? null;
  }),
}));

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { app } = await import("@/server/app");
const { brandRouter } = await import("@/server/routes/brand");

const CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const LOGO = new Uint8Array(
  readFileSync(join(__dirname, "fixtures/branding/logo.svg"))
);
const DARK = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path class="dark" d="M0 0h8v8H0z"/></svg>'
);
const SEED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

function setBranding(patch: Partial<InstanceBranding>) {
  state.branding = {
    name: "Menara",
    company: null,
    accent: "neutral",
    logo: null,
    logoDark: null,
    version: "0",
    ...patch,
  };
}

function storeLogo(theme: "light" | "dark", stored: Stored) {
  state.logos[theme] = stored;
  const key = theme === "dark" ? "logoDark" : "logo";
  setBranding({
    ...state.branding,
    [key]: { type: stored.type },
    version: "kx1",
  });
}

beforeEach(() => {
  setBranding({});
  state.logos = {};
  state.loads = 0;
});

describe("/brand routes", () => {
  it("serves a stored SVG with the sandbox CSP, nosniff and an ETag", async () => {
    storeLogo("light", { bytes: LOGO, type: "image/svg+xml" });
    // The router on its own: the headers are the route's, not the middleware's.
    const res = await new Hono()
      .route("/brand", brandRouter)
      .request("/brand/logo");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("public, no-cache");
    expect(res.headers.get("etag")).toBe('"kx1-light"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(LOGO);
  });

  it("keeps the sandbox CSP through the security-headers middleware", async () => {
    storeLogo("light", { bytes: LOGO, type: "image/svg+xml" });
    for (const path of ["/brand/logo", "/brand/icon.svg", "/brand/icon.png"]) {
      const res = await app.request(path);
      expect(res.headers.get("content-security-policy")).toBe(CSP);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    // Every other route still gets the app's own policy.
    const health = await app.request("/api/health");
    expect(health.headers.get("content-security-policy")).toContain(
      "script-src 'self'"
    );
  });

  it("answers 304 for a matching If-None-Match", async () => {
    storeLogo("light", { bytes: LOGO, type: "image/svg+xml" });
    const res = await app.request("/brand/logo", {
      headers: { "If-None-Match": '"kx1-light"' },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe('"kx1-light"');
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(state.loads).toBe(0);

    // A stale tag gets the bytes again.
    const stale = await app.request("/brand/logo", {
      headers: { "If-None-Match": '"old-light"' },
    });
    expect(stale.status).toBe(200);

    setBranding({ accent: "rose" });
    const mark = await app.request("/brand/logo", {
      headers: { "If-None-Match": 'W/"x", "default-rose"' },
    });
    expect(mark.status).toBe(304);
  });

  it("falls back to the default mark tinted by the instance accent", async () => {
    setBranding({ accent: "rose" });
    const res = await app.request("/brand/logo");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("etag")).toBe('"default-rose"');
    const body = await res.text();
    expect(body).toMatch(/^<svg/);
    expect(body).toContain("oklch(41% 0.159 10.272)"); // rose-900
    expect(state.loads).toBe(0);
  });

  it("serves the dark variant, or the light logo when none is set", async () => {
    storeLogo("light", { bytes: LOGO, type: "image/svg+xml" });
    const fallback = await app.request("/brand/logo?theme=dark");
    expect(fallback.headers.get("etag")).toBe('"kx1-light"');
    expect(new Uint8Array(await fallback.arrayBuffer())).toEqual(LOGO);

    storeLogo("dark", { bytes: DARK, type: "image/svg+xml" });
    const dark = await app.request("/brand/logo?theme=dark");
    expect(dark.headers.get("etag")).toBe('"kx1-dark"');
    expect(await dark.text()).toContain('class="dark"');

    const light = await app.request("/brand/logo");
    expect(new Uint8Array(await light.arrayBuffer())).toEqual(LOGO);
  });

  it("/brand/icon.svg is the SVG logo when one is set", async () => {
    storeLogo("light", { bytes: LOGO, type: "image/svg+xml" });
    const res = await app.request("/brand/icon.svg?accent=green");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(LOGO);
  });

  it("/brand/icon.svg redirects to /brand/icon.png for a raster logo", async () => {
    const png = await new Bun.Image(SEED).resize(128, 128).png().bytes();
    storeLogo("light", { bytes: png, type: "image/png" });
    const res = await app.request("/brand/icon.svg");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/brand/icon.png");
    expect(res.headers.get("content-security-policy")).toBe(CSP);
  });

  it("/brand/icon.png is a 64×64 PNG, and 404 without a raster logo", async () => {
    expect((await app.request("/brand/icon.png")).status).toBe(404);
    storeLogo("light", { bytes: LOGO, type: "image/svg+xml" });
    expect((await app.request("/brand/icon.png")).status).toBe(404);

    const webp = await new Bun.Image(SEED)
      .resize(200, 200)
      .webp({ lossless: true })
      .bytes();
    storeLogo("light", { bytes: webp, type: "image/webp" });
    const res = await app.request("/brand/icon.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("etag")).toBe('"kx1-icon"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(await new Bun.Image(bytes).metadata()).toMatchObject({
      width: 64,
      height: 64,
      format: "png",
    });

    // Cached per version: the second answer does not resize again.
    const loads = state.loads;
    const again = await app.request("/brand/icon.png");
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(bytes);
    expect(state.loads).toBe(loads);
  });
});
