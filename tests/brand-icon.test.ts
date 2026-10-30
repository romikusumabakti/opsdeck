import { afterEach, describe, expect, it } from "vitest";
import { GET } from "@/app/brand/icon.svg/route";

const saved = process.env.BRAND;
afterEach(() => {
  if (saved === undefined) delete process.env.BRAND;
  else process.env.BRAND = saved;
});

async function fetchIcon(query: string, brand?: string) {
  if (brand === undefined) delete process.env.BRAND;
  else process.env.BRAND = brand;
  const res = GET(new Request(`http://localhost/brand/icon.svg${query}`));
  return { res, body: await res.text() };
}

describe("GET /brand/icon.svg", () => {
  it("serves a cacheable SVG", async () => {
    const { res, body } = await fetchIcon("?accent=blue", "dss");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toMatch(/^public/);
    expect(body).toMatch(/^<svg/);
  });

  it("colours the mark with the requested accent", async () => {
    const { body } = await fetchIcon("?accent=rose", "dss");
    expect(body).toContain("oklch(41% 0.159 10.272)"); // rose-900
    expect(body).toContain("oklch(89.2% 0.058 10.001)"); // rose-200
  });

  it("uses the brand default for a missing, empty or unknown accent", async () => {
    for (const query of [
      "",
      "?accent=",
      "?accent=teal",
      "?accent=%3Cscript%3E",
    ]) {
      const { res, body } = await fetchIcon(query, "dss");
      expect(res.status).toBe(200);
      expect(body).toContain("oklch(37.9% 0.146 265.522)"); // blue-900
    }
  });

  it("draws neutral in black and white", async () => {
    const { body } = await fetchIcon("?accent=neutral", "dss");
    expect(body).toContain("#171717");
    expect(body).toContain("#fafafa");
    expect(body).not.toContain("oklch(");
  });

  it("keeps the brand's shape whatever the accent", async () => {
    const dss = (await fetchIcon("?accent=neutral", "dss")).body;
    const plain = (await fetchIcon("?accent=neutral")).body;
    expect(dss).not.toBe(plain);
  });

  it("adapts to the browser's colour scheme, since it can't see the app theme", async () => {
    for (const accent of ["neutral", "blue", "yellow"]) {
      const { body } = await fetchIcon(`?accent=${accent}`, "dss");
      expect(body).toContain("prefers-color-scheme: dark");
    }
  });
});
