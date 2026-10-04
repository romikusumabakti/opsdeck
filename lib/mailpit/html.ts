import type { MailAttachment } from "./schemas";

// Prepares a message's HTML for `<iframe srcdoc sandbox>` in the inbox. The
// app-wide `frame-ancestors 'none'` header rules out pointing an iframe at an
// OpsDeck route, and a sandboxed (opaque-origin) frame couldn't send the
// session cookie to fetch inline parts anyway — so inline images are baked
// in as data: URIs server-side.

export const MAX_INLINE_PART_BYTES = 2 * 1024 * 1024;
export const MAX_INLINE_TOTAL_BYTES = 10 * 1024 * 1024;

// Defence in depth on top of the sandbox (which already blocks scripts): no
// scripts/plugins/form posts, no Referer leaking the OpsDeck URL to remote
// image hosts, and links open in a new tab instead of navigating the frame.
export const HTML_PRELUDE =
  `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; form-action 'none'">` +
  `<meta name="referrer" content="no-referrer">` +
  `<base target="_blank">`;

const CID_RE = /cid:([^"'\s)>]+)/gi;
const SAFE_CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

function normaliseCid(id: string): string {
  let value = id;
  try {
    value = decodeURIComponent(id);
  } catch {
    // keep the raw value
  }
  return value.replace(/^<|>$/g, "").toLowerCase();
}

export function referencedCids(html: string): Set<string> {
  const found = new Set<string>();
  for (const match of html.matchAll(CID_RE)) {
    if (match[1]) found.add(normaliseCid(match[1]));
  }
  return found;
}

export function pickInlineParts(
  inline: MailAttachment[],
  referenced: Set<string>
): MailAttachment[] {
  const picked: MailAttachment[] = [];
  let total = 0;
  for (const part of inline) {
    if (!part.ContentID || !referenced.has(normaliseCid(part.ContentID))) {
      continue;
    }
    if (part.Size > MAX_INLINE_PART_BYTES) continue;
    if (total + part.Size > MAX_INLINE_TOTAL_BYTES) continue;
    total += part.Size;
    picked.push(part);
  }
  return picked;
}

export function toDataUri(contentType: string, bytes: Uint8Array): string {
  // The type comes from the (untrusted) email; anything odd could break out
  // of the src attribute, so fall back to a neutral type.
  const type = SAFE_CONTENT_TYPE.test(contentType)
    ? contentType
    : "application/octet-stream";
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function inlineCids(
  html: string,
  dataUris: Map<string, string>
): string {
  const lookup = new Map(
    [...dataUris].map(([cid, uri]) => [normaliseCid(cid), uri])
  );
  return html.replace(
    CID_RE,
    (match, id: string) => lookup.get(normaliseCid(id)) ?? match
  );
}

export function withPrelude(html: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + HTML_PRELUDE + html.slice(at);
  }
  return `<!doctype html><html><head>${HTML_PRELUDE}</head><body>${html}</body></html>`;
}
