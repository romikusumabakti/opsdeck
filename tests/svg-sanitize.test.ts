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

  it("keeps url(#gradient) in attributes and a harmless <style>", () => {
    expect(hostile).toContain('fill="url(#gradient)"');
    expect(hostile).toContain(".ok { fill: url(#gradient); }");
  });

  it("keeps quoted in-document references: url('#g') and url(\"#g\")", async () => {
    const svg = await clean(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><defs><linearGradient id="g"><stop offset="0" stop-color="#2563eb"/></linearGradient></defs><style>.a { fill: url("#g"); }</style><rect class="a" width="4" height="4"/><rect x="4" fill="url('#g')" width="4" height="4"/><rect y="4" style="stroke: url(&quot;#g&quot;)" width="4" height="4"/></svg>`
    );
    expect(svg).toContain('.a { fill: url("#g"); }');
    expect(svg).toContain(`fill="url('#g')"`);
    expect(svg).toContain('style="stroke: url(&quot;#g&quot;)"');
  });

  // A value that would leave the document (or hide behind an escape) is not
  // stripped: stripping a fill, a style or a stylesheet recolours the logo
  // without telling the admin, so the upload is refused instead.
  const wrap = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">${body}<rect width="8" height="8"/></svg>`;
  const refused: [string, string][] = [
    [
      "@import in <style>",
      "<style>@import url(https://evil.example.com/x.css);</style>",
    ],
    [
      "external url() in <style>",
      "<style>rect { fill: url(https://evil.example.com/paint.svg#p); }</style>",
    ],
    [
      "a CSS escape in <style>",
      '<style>rect{fill:u\\72l(https://evil.example.com/e.svg#p)} @\\69mport "https://evil.example.com/e.css";</style>',
    ],
    [
      "image-set() in <style>",
      '<style>rect{background:image-set("https://evil.example.com/set.png" 1x)}</style>',
    ],
    [
      "-webkit-image-set() in <style>",
      '<style>rect{background:-webkit-image-set("https://evil.example.com/w.png" 1x)}</style>',
    ],
    [
      "cross-fade() in <style>",
      '<style>rect{background:cross-fade(url(#g), "https://evil.example.com/f.png")}</style>',
    ],
    [
      "external url() in a style attribute",
      '<rect style="fill:url(https://evil.example.com/paint.svg#p)"/>',
    ],
    [
      "a quoted external url() in fill",
      `<rect fill="url('https://evil.example.com/paint.svg#p')"/>`,
    ],
    [
      "a quoted url() that only ends in a fragment",
      `<rect fill="url('https://evil.example.com/#x')"/>`,
    ],
    ["a spaced, quoted fragment url()", `<rect fill="url( '#x' )"/>`],
    [
      "expression() in a style attribute",
      '<rect style="width: expression(alert(3))"/>',
    ],
    [
      "a CSS escape in a style attribute",
      '<rect style="fill:u\\72l(https://evil.example.com/e.svg#p)"/>',
    ],
    [
      "a CSS escape in fill",
      '<rect fill="u\\72l(https://evil.example.com/e.svg#p)"/>',
    ],
    [
      "image-set() in a style attribute",
      '<rect style="fill:image-set(&quot;https://evil.example.com/s.png&quot; 1x)"/>',
    ],
  ];
  for (const [what, body] of refused) {
    it(`rejects ${what} instead of stripping it`, async () => {
      expect(await sanitizeSvg(wrap(body))).toEqual({
        ok: false,
        error: "invalid_svg",
      });
    });
  }

  it("still accepts a file after rejecting one (the check is per upload)", async () => {
    await sanitizeSvg(wrap(refused[0]?.[1] ?? ""));
    expect((await sanitizeSvg(wrap(""))).ok).toBe(true);
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
