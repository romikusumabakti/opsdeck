// Pure markdown/slug helpers for knowledge documents. No database or session
// imports, so scripts (the demo seed) can use them without loading auth.

/**
 * Derive a URL slug from a title: lowercase, ASCII-fold the common cases, and
 * collapse anything non-alphanumeric to single hyphens. Matches the shape
 * enforced by knowledgeSlugSchema. Empty result falls back to "untitled" so the
 * caller always gets a routable token to dedupe against.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    // strip combining marks left by NFKD so "café" -> "cafe"
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

/**
 * Strip markdown syntax to a plain-text approximation for the FTS column. Not a
 * full parser — drops code fences, link/image syntax, headings, emphasis, and
 * list/quote markers so search indexes words, not punctuation.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/^[\s>*+-]+/gm, " ") // list/quote/bullet markers
    .replace(/[*_~]+/g, "") // emphasis
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull the slugs of every internal document link in a markdown body. Recognizes
 * `/knowledge/<slug>` and `/<locale>/knowledge/<slug>` hrefs (locale-prefixed
 * routing). Returns a de-duplicated list; the caller resolves slugs to ids when
 * rebuilding the backlink graph.
 */
export function extractLinkedSlugs(markdown: string): string[] {
  // Strip fenced and inline code first so a `/knowledge/<slug>` shown as a code
  // example isn't mistaken for a real link and counted as a backlink edge.
  const body = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  const re = /\]\((?:\/[a-z]{2})?\/knowledge\/([a-z0-9-]+)\)/g;
  const slugs = new Set<string>();
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
  while ((m = re.exec(body)) !== null) {
    if (m[1]) slugs.add(m[1]);
  }
  return [...slugs];
}
