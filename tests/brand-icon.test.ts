import { afterEach, describe, expect, it } from "bun:test";
import { GET } from "@/app/brand/icon.svg/route";

const saved = process.env.BRAND_LOGO;

afterEach(() => {
  if (saved === undefined) delete process.env.BRAND_LOGO;
  else process.env.BRAND_LOGO = saved;
});

async function fetchIcon(logo: string | undefined) {
  if (logo === undefined) delete process.env.BRAND_LOGO;
  else process.env.BRAND_LOGO = logo;
  const res = GET();
  return { res, body: await res.text() };
}

describe("GET /brand/icon.svg", () => {
  it("serves an SVG", async () => {
    const { res, body } = await fetchIcon(undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(body).toStartWith("<svg");
  });

  it("serves the DSS mark when BRAND_LOGO=dss", async () => {
    const { body } = await fetchIcon("dss");
    expect(body).toContain("#203864");
  });

  it("falls back to the neutral mark when BRAND_LOGO is unset", async () => {
    const { body } = await fetchIcon(undefined);
    expect(body).not.toContain("#203864");
  });

  it("adapts to the browser's colour scheme, since it can't see the app theme", async () => {
    for (const logo of ["default", "dss"]) {
      const { body } = await fetchIcon(logo);
      expect(body).toContain("prefers-color-scheme: dark");
    }
  });
});
