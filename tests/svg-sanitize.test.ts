import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sanitizeSvg } from "@/lib/svg-sanitize";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures/branding", name), "utf8");

async function clean(source: string): Promise<string> {
  const result = await sanitizeSvg(source);
  if (!result.ok) throw new Error(`rejected: ${result.error}`);
  return result.svg;
}

describe("sanitizeSvg", () => {
  let hostile: string;
  beforeAll(async () => {
    hostile = await clean(fixture("hostile.svg"));
  });

  it("removes script, event handlers and foreignObject", () => {
    expect(hostile).not.toMatch(/<script/i);
    expect(hostile).not.toMatch(/\son[a-z]+\s*=/i);
    expect(hostile).not.toMatch(/foreignObject/i);
    expect(hostile).not.toMatch(/alert\(/);
    expect(hostile).not.toMatch(/javascript:/i);
    expect(hostile).not.toMatch(/<image/i);
    expect(hostile).not.toMatch(/<a[\s>]/i);
  });

  it("drops every href that is not a fragment, including data: and javascript:", () => {
    expect(hostile).not.toMatch(/(?:xlink:)?href="(?!#)/);
    expect(hostile).not.toMatch(/data:/i);
    expect(hostile).not.toMatch(/evil\.example\.com/);
  });

  it("keeps a fragment href", async () => {
    const svg = await clean(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path id="p" d="M0 0h8"/><text><textPath href="#p">A</textPath></text></svg>'
    );
    expect(svg).toContain('<textPath href="#p">');
  });

  it("writes well-formed XML with the namespaces it uses", async () => {
    const svg = await clean(
      '<svg viewBox="0 0 8 8"><text><textPath xlink:href="#p">A</textPath></text><rect>'
    );
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    // The xlink prefix is declared (under whatever name the serializer picks).
    expect(svg).toMatch(
      /xmlns:([a-z0-9]+)="http:\/\/www\.w3\.org\/1999\/xlink" \1:href="#p"/
    );
    expect(svg).toMatch(/<\/svg>$/);
  });

  it("keeps url(#gradient) but drops external url() in attributes and style", () => {
    expect(hostile).toContain('fill="url(#gradient)"');
    expect(hostile).not.toMatch(/url\(\s*['"]?(?!#)/i);
    expect(hostile).not.toMatch(/expression\(/i);
  });

  it("removes a <style> with @import or an external url()", () => {
    expect(hostile).not.toMatch(/@import/i);
    // The harmless stylesheet stays.
    expect(hostile).toContain(".ok { fill: url(#gradient); }");
  });

  it("rejects a DOCTYPE or ENTITY declaration", async () => {
    expect(await sanitizeSvg(fixture("doctype.svg"))).toEqual({
      ok: false,
      error: "invalid_svg",
    });
    expect(
      await sanitizeSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><!ENTITY x "y"></svg>'
      )
    ).toEqual({ ok: false, error: "invalid_svg" });
    expect(await sanitizeSvg("<!doctype html><svg></svg>")).toEqual({
      ok: false,
      error: "invalid_svg",
    });
  });

  it("rejects a document whose root is not one <svg>", async () => {
    expect(
      await sanitizeSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"></svg><svg xmlns="http://www.w3.org/2000/svg"></svg>'
      )
    ).toEqual({ ok: false, error: "invalid_svg" });
    expect(await sanitizeSvg("<div>hi</div>")).toEqual({
      ok: false,
      error: "invalid_svg",
    });
    expect(await sanitizeSvg("not markup")).toEqual({
      ok: false,
      error: "invalid_svg",
    });
  });

  it("keeps a plain square logo's paths and viewBox", async () => {
    const svg = await clean(fixture("logo.svg"));
    expect(svg).toMatch(/^<svg[^>]*viewBox="0 0 64 64"/);
    expect(svg).toContain('d="M20 20h24v24H20z"');
    expect(svg).toContain("<linearGradient");
    expect(svg).toContain('fill="url(#gradient)"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
});
