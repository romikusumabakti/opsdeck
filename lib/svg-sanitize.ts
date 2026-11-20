import createDOMPurify from "dompurify";

/**
 * Sanitizes an uploaded SVG logo. The result is served from the app's own
 * origin (/brand/logo, the favicon), so it must carry nothing that runs or
 * fetches: no scripts, event handlers or foreign objects, and no reference
 * other than an in-document `#fragment` (no external `href`, `url(…)` or
 * `@import`). /brand also sends a sandbox CSP; this is the first line.
 *
 * Server-only. jsdom is loaded on first use, so importing this module costs
 * nothing until an admin uploads a logo.
 */

export type SanitizeSvgResult =
  | { ok: true; svg: string }
  | { ok: false; error: "invalid_svg" };

// XML entity expansion and external entities: refused outright, never parsed.
const DECLARATION = /<!(?:DOCTYPE|ENTITY)/i;
// Checked on every attribute value (presentation attributes such as fill are
// CSS too) and on <style> text:
//   - a reference that leaves the document: url() other than url(#…),
//     @import, and the CSS functions that take a URL as a plain string;
//   - old IE script-in-CSS;
//   - any backslash: a CSS escape (`u\72l(`, `@\69mport`) hides the rest.
const UNSAFE_VALUE = [
  /url\(\s*['"]?(?!#)/i,
  /@import/i,
  /expression\(/i,
  /(?:-webkit-)?image-set\(/i,
  /cross-fade\(/i,
  /(?<![-\w])(?:image|src)\(/i,
  /\\/,
];

const unsafe = (value: string) => UNSAFE_VALUE.some((re) => re.test(value));

type Purifier = {
  purify: ReturnType<typeof createDOMPurify>;
  serializer: XMLSerializer;
  parser: DOMParser;
};
let purifier: Promise<Purifier> | null = null;

async function createPurifier(): Promise<Purifier> {
  const { JSDOM } = await import("jsdom");
  const { window } = new JSDOM("");
  const purify = createDOMPurify(
    window as unknown as Window & typeof globalThis
  );
  purify.addHook("uponSanitizeAttribute", (_node, data) => {
    const name = data.attrName.toLowerCase();
    const value = data.attrValue.trim();
    if (
      // href and xlink:href (any prefix: the name the parser gave it).
      ((name === "href" || name.endsWith(":href")) && !value.startsWith("#")) ||
      name.startsWith("on") ||
      unsafe(value)
    ) {
      data.keepAttr = false;
    }
  });
  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && unsafe(node.textContent ?? "")) {
      node.parentNode?.removeChild(node);
    }
  });
  return {
    purify,
    serializer: new window.XMLSerializer(),
    parser: new window.DOMParser(),
  };
}

export async function sanitizeSvg(source: string): Promise<SanitizeSvgResult> {
  if (DECLARATION.test(source)) return { ok: false, error: "invalid_svg" };
  purifier ??= createPurifier();
  const { purify, serializer, parser } = await purifier;
  const root = purify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject", "image", "a", "iframe"],
    RETURN_DOM_FRAGMENT: true,
  });
  const elements = Array.from(root?.childNodes ?? []).filter(
    (node) => node.nodeType === 1
  ) as Element[];
  const [svg] = elements;
  if (!svg || elements.length !== 1 || svg.nodeName.toLowerCase() !== "svg") {
    return { ok: false, error: "invalid_svg" };
  }
  // DOMPurify parses as HTML (its XHTML mode is case-sensitive and drops
  // viewBox, linearGradient, …). The file is served as image/svg+xml, so it is
  // written out as XML, with every namespace prefix it uses declared, and must
  // parse back as XML to a lone <svg>; anything else is refused.
  const out = serializer.serializeToString(svg);
  const reparsed = parser.parseFromString(out, "image/svg+xml");
  if (
    reparsed.documentElement.localName !== "svg" ||
    reparsed.getElementsByTagName("parsererror").length > 0
  ) {
    return { ok: false, error: "invalid_svg" };
  }
  return { ok: true, svg: out };
}
