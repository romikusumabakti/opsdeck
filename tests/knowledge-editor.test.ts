// @vitest-environment happy-dom
// Round-trip fidelity guard for the knowledge editor. The editor parses and
// serializes markdown with @tiptap/markdown (marked under the hood), while the
// read-side renderer (components/markdown-content) parses with react-markdown +
// remark-gfm. Two different markdown engines means a construct the editor emits
// could render differently than the WYSIWYG surface showed. These tests pin the
// contract from BOTH sides:
//   1. the editor's serialize is stable (parse∘serialize is idempotent), and
//   2. what the editor emits parses to the structure react-markdown expects.
// Both build from buildEditorExtensions — the same config the live editor runs.

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildEditorExtensions,
  editorMarkdown,
} from "@/lib/knowledge-editor-extensions";

// Tiptap's Editor reaches for window/document at construction; happy-dom
// (registered in tests/preload.ts) provides them. Import lazily after the env
// is up.
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

/** Render markdown through the read-side engine and return static HTML.
 *  Plugins mirror components/markdown-content (rehype-slug omitted — it only
 *  adds heading ids and would make every heading assertion noisier). */
function renderHtml(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeHighlight] },
      markdown
    )
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
    // The language must survive the fence round-trip (```ts stays ```ts) AND
    // actually highlight on the read side — hljs-keyword proves rehype-
    // highlight recognized the language, not just passed the class through.
    name: "fenced code with language",
    md: '```ts\nconst x = "y";\n```',
    html: '<span class="hljs-keyword">const</span>',
  },
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
  {
    name: "task list",
    md: "- [ ] open\n- [x] done",
    html: '<input type="checkbox"',
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

// Review Focus: a stored document (tables, images with alt, task lists, code
// blocks with a language, headings, quotes, links and /knowledge/<slug> doc
// links) must come back byte-identical after open + save without edits.
//
// `knowledge-round-trip.md` is a document in the editor's canonical form —
// what every document saved through the editor already looks like. The file
// ends with one newline for POSIX tooling; the stored body does not (the
// serializer never emits a trailing newline), so that one byte is stripped.
//
// `knowledge-round-trip.authored.md` is the same document written by hand (or
// imported/created through the API). Opening it normalises exactly as pinned
// here, unchanged from the editor before the contextual menus:
//   - GFM table cells are padded so the pipes line up;
//   - a table is surrounded by two blank lines instead of one;
//   - the trailing newline is dropped.
// Everything else (headings, emphasis, quotes, lists, task lists, fences with
// their language, links, doc links, images with alt) is byte-identical.
function fixture(name: string): string {
  // cwd-relative: happy-dom swaps the URL global, so new URL(…, import.meta.url)
  // does not resolve to the file here.
  return readFileSync(`tests/fixtures/${name}`, "utf8");
}

describe("knowledge document fixture round-trip", () => {
  const stored = fixture("knowledge-round-trip.md").replace(/\n$/, "");

  it("covers every construct the editor stores", () => {
    for (const needle of [
      "| ---",
      "![Network diagram of the staging cluster](",
      "- [ ] ",
      "- [x] ",
      "```bash\n",
      "```ts\n",
      "\n## ",
      "\n### ",
      "\n> ",
      "](https://example.com/docs)",
      "](/knowledge/release-checklist)",
    ]) {
      expect(stored).toContain(needle);
    }
  });

  it("is byte-identical after open + serialize without edits", () => {
    expect(serialize(stored)).toBe(stored);
  });

  it("normalises a hand-written document exactly as before", () => {
    const authored = fixture("knowledge-round-trip.authored.md");
    expect(serialize(authored)).toBe(stored);
    // The only differences are the documented ones: undo them and the
    // hand-written source and the stored form are the same text.
    const unpad = (md: string) =>
      md
        .split("\n")
        .map((line) =>
          line.startsWith("|")
            ? line.replace(/ {2,}\|/g, " |").replace(/-{3,}/g, "---")
            : line
        )
        .join("\n")
        .replace(/\n{3,}/g, "\n\n");
    expect(unpad(stored)).toBe(authored.replace(/\n$/, ""));
  });
});

describe("unedited documents ending in a block", () => {
  // StarterKit's TrailingNode appends an empty paragraph after a final table,
  // image or code block on the first transaction (clicking into the text).
  // The stored markdown must not pick that up.
  it.each([
    ["image", "Intro\n\n![A diagram](/api/knowledge/asset/abc)"],
    ["code block", "Intro\n\n```ts\nconst x = 1;\n```"],
    ["table", "Intro\n\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n"],
    ["the fixture", fixture("knowledge-round-trip.md").replace(/\n$/, "")],
  ])("%s stays byte-identical after a selection change", (_name, md) => {
    const editor = editorWith(md);
    editor.commands.setTextSelection(2);
    expect(editorMarkdown(editor)).toBe(md);
    editor.destroy();
  });

  it("keeps a single empty paragraph document empty", () => {
    const editor = editorWith("");
    editor.commands.setTextSelection(1);
    expect(editorMarkdown(editor)).toBe("");
    editor.destroy();
  });
});
