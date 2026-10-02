import { describe, expect, it } from "bun:test";
import {
  HTML_PRELUDE,
  inlineCids,
  MAX_INLINE_PART_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  pickInlineParts,
  referencedCids,
  toDataUri,
  withPrelude,
} from "@/lib/mailpit/html";
import type { MailAttachment } from "@/lib/mailpit/schemas";

function part(contentId: string, size = 100): MailAttachment {
  return {
    PartID: contentId,
    FileName: `${contentId}.png`,
    ContentType: "image/png",
    ContentID: contentId,
    Size: size,
  };
}

describe("referencedCids", () => {
  it("finds cid refs in src attributes and CSS url()", () => {
    const html = `<img src="cid:logo@app"><div style="background:url(cid:BG)"></div><img src='cid:a%40b'>`;
    expect([...referencedCids(html)].sort()).toEqual(["a@b", "bg", "logo@app"]);
  });
});

describe("pickInlineParts", () => {
  it("keeps only referenced parts", () => {
    const picked = pickInlineParts([part("logo@app"), part("unused")], new Set(["logo@app"]));
    expect(picked.map((p) => p.ContentID)).toEqual(["logo@app"]);
  });

  it("matches Content-IDs wrapped in angle brackets", () => {
    const picked = pickInlineParts([part("<logo@app>")], new Set(["logo@app"]));
    expect(picked).toHaveLength(1);
  });

  it("skips parts over the per-part cap", () => {
    const picked = pickInlineParts(
      [part("big", MAX_INLINE_PART_BYTES + 1)],
      new Set(["big"])
    );
    expect(picked).toEqual([]);
  });

  it("stops adding once the total cap would be exceeded", () => {
    const size = MAX_INLINE_PART_BYTES;
    const count = MAX_INLINE_TOTAL_BYTES / size + 1;
    const parts = Array.from({ length: count }, (_, i) => part(`p${i}`, size));
    const picked = pickInlineParts(parts, new Set(parts.map((p) => p.ContentID)));
    expect(picked).toHaveLength(count - 1);
  });
});

describe("toDataUri", () => {
  it("base64-encodes with the content type", () => {
    expect(toDataUri("image/png", new Uint8Array([1, 2, 3]))).toBe(
      "data:image/png;base64,AQID"
    );
  });

  it("refuses content types that could break out of the attribute", () => {
    expect(toDataUri('image/png" onerror="x', new Uint8Array([1]))).toBe(
      "data:application/octet-stream;base64,AQ=="
    );
  });
});

describe("inlineCids", () => {
  it("replaces known refs and leaves unknown ones", () => {
    const html = `<img src="cid:logo@app"><img src="cid:missing">`;
    const out = inlineCids(html, new Map([["<logo@app>", "data:image/png;base64,AQID"]]));
    expect(out).toBe(`<img src="data:image/png;base64,AQID"><img src="cid:missing">`);
  });
});

describe("withPrelude", () => {
  it("injects right after an existing <head>", () => {
    const out = withPrelude(`<html><head lang="en"><title>x</title></head><body>b</body></html>`);
    expect(out).toBe(
      `<html><head lang="en">${HTML_PRELUDE}<title>x</title></head><body>b</body></html>`
    );
  });

  it("wraps a fragment in a document", () => {
    expect(withPrelude("<p>hi</p>")).toBe(
      `<!doctype html><html><head>${HTML_PRELUDE}</head><body><p>hi</p></body></html>`
    );
  });

  it("blocks scripts and sends links to a new tab", () => {
    expect(HTML_PRELUDE).toContain("script-src 'none'");
    expect(HTML_PRELUDE).toContain('<base target="_blank">');
    expect(HTML_PRELUDE).toContain('content="no-referrer"');
  });
});
