import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccentColor } from "@/lib/accents";

const state = vi.hoisted(() => ({ accent: "blue" as AccentColor }));

vi.mock("@/lib/instance-branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instance-branding")>()),
  getBranding: vi.fn(async () => ({
    name: "Menara",
    company: null,
    accent: state.accent,
    logo: null,
    logoDark: null,
    version: "0",
  })),
}));

const { app } = await import("@/server/app");

async function fetchIcon(query: string) {
  const res = await app.request(`/brand/icon.svg${query}`);
  return { res, body: await res.text() };
}

beforeEach(() => {
  state.accent = "blue";
});

describe("GET /brand/icon.svg", () => {
  it("serves a cacheable SVG", async () => {
    const { res, body } = await fetchIcon("?accent=blue");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toMatch(/^public/);
    expect(res.headers.get("etag")).toBe(
      `"default-blue-${Bun.hash(body).toString(36)}"`
    );
    expect(body).toMatch(/^<svg/);
  });

  it("colours the mark with the requested accent", async () => {
    const { body } = await fetchIcon("?accent=rose");
    expect(body).toContain("oklch(41% 0.159 10.272)"); // rose-900
    expect(body).toContain("oklch(89.2% 0.058 10.001)"); // rose-200
  });

  it("uses the instance accent for a missing, empty or unknown accent", async () => {
    for (const query of [
      "",
      "?accent=",
      "?accent=teal",
      "?accent=%3Cscript%3E",
    ]) {
      const { res, body } = await fetchIcon(query);
      expect(res.status).toBe(200);
      expect(body).toContain("oklch(37.9% 0.146 265.522)"); // blue-900
    }
    state.accent = "neutral";
    const { body } = await fetchIcon("?accent=teal");
    expect(body).toContain("#171717");
    expect(body).not.toContain("oklch(");
  });

  it("draws neutral in black and white", async () => {
    const { body } = await fetchIcon("?accent=neutral");
    expect(body).toContain("#171717");
    expect(body).toContain("#fafafa");
    expect(body).not.toContain("oklch(");
  });

  it("adapts to the browser's colour scheme, since it can't see the app theme", async () => {
    for (const accent of ["neutral", "blue", "yellow"]) {
      const { body } = await fetchIcon(`?accent=${accent}`);
      expect(body).toContain("prefers-color-scheme: dark");
    }
  });
});
