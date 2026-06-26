// @vitest-environment jsdom
//
// Round-trip fidelity guard for the knowledge editor. The editor parses and
// serializes markdown with @tiptap/markdown (marked under the hood), while the
// read-side renderer (components/markdown-content) parses with react-markdown +
// remark-gfm. Two different markdown engines means a construct the editor emits
// could render differently than the WYSIWYG surface showed. These tests pin the
// contract from BOTH sides:
//   1. the editor's serialize is stable (parse∘serialize is idempotent), and
//   2. what the editor emits parses to the structure react-markdown expects.
// Both build from buildEditorExtensions — the same config the live editor runs.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "@/lib/knowledge-editor-extensions";

// Tiptap's Editor reaches for window/document at construction; jsdom (set by
// the docblock above) provides them. Import lazily after the env is up.
let Editor: typeof import("@tiptap/react").Editor;

beforeAll(async () => {
  ({ Editor } = await import("@tiptap/react"));
});

/** Build a throwaway editor seeded with markdown, like KnowledgeEditor does. */
function editorWith(markdown: string) {
  return new Editor({
    extensions: buildEditorExtensions(),
    content: markdown,
    contentType: "markdown",
  });
}

/** Markdown as the editor would emit it for the given source. */
function serialize(markdown: string): string {
  const editor = editorWith(markdown);
  const out = editor.getMarkdown();
  editor.destroy();
  return out;
}

/** Render markdown through the read-side engine and return static HTML. */
function renderHtml(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown)
  );
}

// Each case: the construct, source markdown, and a substring the read-side HTML
// must contain. The HTML check is what actually catches cross-engine drift —
// the editor can serialize anything, but it has to land as the right element.
const CASES: { name: string; md: string; html: string }[] = [
  { name: "bold", md: "**bold**", html: "<strong>bold</strong>" },
  { name: "italic", md: "*it*", html: "<em>it</em>" },
  { name: "strikethrough", md: "~~gone~~", html: "<del>gone</del>" },
  { name: "h2", md: "## Title", html: "<h2>Title</h2>" },
  { name: "h3", md: "### Sub", html: "<h3>Sub</h3>" },
  { name: "bullet list", md: "- a\n- b", html: "<ul>" },
  { name: "ordered list", md: "1. a\n2. b", html: "<ol>" },
  { name: "blockquote", md: "> quote", html: "<blockquote>" },
  { name: "inline code", md: "`x`", html: "<code>x</code>" },
  { name: "code block", md: "```\ncode\n```", html: "<pre>" },
  {
    name: "external link",
    md: "[site](https://example.com)",
    html: '<a href="https://example.com">site</a>',
  },
  {
    name: "internal doc link (backlink syntax)",
    md: "[Doc](/knowledge/some-doc)",
    html: '<a href="/knowledge/some-doc">Doc</a>',
  },
  {
    name: "image with alt",
    md: "![a cat](/api/knowledge/asset/abc)",
    html: '<img src="/api/knowledge/asset/abc" alt="a cat"',
  },
  {
    name: "gfm table",
    md: "| x | y |\n| --- | --- |\n| 1 | 2 |",
    html: "<table>",
  },
];

describe("knowledge editor markdown round-trip", () => {
  it.each(CASES)("serialize is stable for $name", ({ md }) => {
    const once = serialize(md);
    const twice = serialize(once);
    expect(twice).toBe(once);
  });

  it.each(CASES)(
    "editor output renders as expected for $name",
    ({ md, html }) => {
      expect(renderHtml(serialize(md))).toContain(html);
    }
  );

  it("preserves an internal link as a real backlink edge", () => {
    // The backlink extractor keys off `](/knowledge/<slug>)` — if serialize
    // ever drops or rewrites that, backlinks silently break.
    expect(serialize("See [Doc](/knowledge/foo-bar).")).toContain(
      "](/knowledge/foo-bar)"
    );
  });

  it("drops underline to plain text (no markdown representation)", () => {
    // Underline is intentionally disabled; ensure no raw <u> leaks into the
    // serialized markdown, which the read-side would not sanitize.
    expect(serialize("<u>x</u>")).not.toContain("<u>");
  });
});
