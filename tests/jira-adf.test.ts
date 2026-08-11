import { describe, expect, it } from "vitest";
import {
  adfToMarkdown,
  markdownToAdf,
  markdownToRichText,
  richTextToMarkdown,
} from "@/lib/jira/adf";
import type { AdfNode } from "@/lib/jira/types";

const doc = (...content: AdfNode[]): AdfNode => ({
  type: "doc",
  content,
});
const text = (value: string, marks?: AdfNode["marks"]): AdfNode => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});

describe("adfToMarkdown", () => {
  it("renders paragraphs separated by a blank line", () => {
    expect(
      adfToMarkdown(
        doc(
          { type: "paragraph", content: [text("first")] },
          { type: "paragraph", content: [text("second")] }
        )
      )
    ).toBe("first\n\nsecond");
  });

  it("renders headings at their level, clamped to six", () => {
    expect(
      adfToMarkdown(
        doc(
          { type: "heading", attrs: { level: 2 }, content: [text("Scope")] },
          { type: "heading", attrs: { level: 9 }, content: [text("Deep")] }
        )
      )
    ).toBe("## Scope\n\n###### Deep");
  });

  it("applies emphasis marks", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "paragraph",
          content: [
            text("bold", [{ type: "strong" }]),
            text(" and "),
            text("italic", [{ type: "em" }]),
            text(" and "),
            text("gone", [{ type: "strike" }]),
          ],
        })
      )
    ).toBe("**bold** and *italic* and ~~gone~~");
  });

  it("keeps inline code literal instead of nesting other marks inside it", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "paragraph",
          content: [text("npm i", [{ type: "code" }, { type: "strong" }])],
        })
      )
    ).toBe("`npm i`");
  });

  it("wraps a link around the marks it carries", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "paragraph",
          content: [
            text("docs", [
              { type: "strong" },
              { type: "link", attrs: { href: "https://x.test/a" } },
            ]),
          ],
        })
      )
    ).toBe("[**docs**](https://x.test/a)");
  });

  it("renders a code block with its language", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "codeBlock",
          attrs: { language: "sql" },
          content: [text("select 1;")],
        })
      )
    ).toBe("```sql\nselect 1;\n```");
  });

  it("renders nested lists with aligned indentation", () => {
    const markdown = adfToMarkdown(
      doc({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [text("outer")] },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [text("inner")] }],
                  },
                ],
              },
            ],
          },
        ],
      })
    );
    expect(markdown).toBe("- outer\n  - inner");
  });

  it("numbers ordered lists from one", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [text("a")] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [text("b")] }],
            },
          ],
        })
      )
    ).toBe("1. a\n2. b");
  });

  it("promotes the first table row to a GFM header and escapes pipes", () => {
    const cell = (value: string): AdfNode => ({
      type: "tableCell",
      content: [{ type: "paragraph", content: [text(value)] }],
    });
    expect(
      adfToMarkdown(
        doc({
          type: "table",
          content: [
            { type: "tableRow", content: [cell("env"), cell("host")] },
            { type: "tableRow", content: [cell("qa"), cell("a|b")] },
          ],
        })
      )
    ).toBe("| env | host |\n| --- | --- |\n| qa | a\\|b |");
  });

  it("keeps the text of an unknown container instead of dropping it", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "panel",
          attrs: { panelType: "warning" },
          content: [{ type: "paragraph", content: [text("careful")] }],
        })
      )
    ).toBe("careful");
  });

  it("renders a mention as its display text", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "paragraph",
          content: [
            { type: "mention", attrs: { text: "@Budi", id: "acc-1" } },
            text(" please look"),
          ],
        })
      )
    ).toBe("@Budi please look");
  });

  it("treats a missing document as empty", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown(undefined)).toBe("");
  });
});

describe("richTextToMarkdown", () => {
  it("passes a Data Center wiki-markup string through unchanged", () => {
    expect(richTextToMarkdown("h1. Title\n* one")).toBe("h1. Title\n* one");
  });

  it("converts a Cloud ADF object", () => {
    expect(
      richTextToMarkdown(doc({ type: "paragraph", content: [text("hi")] }))
    ).toBe("hi");
  });

  it("maps null and undefined to an empty string", () => {
    expect(richTextToMarkdown(null)).toBe("");
    expect(richTextToMarkdown(undefined)).toBe("");
  });
});

describe("markdownToAdf", () => {
  it("emits one empty paragraph for empty input (ADF needs a block)", () => {
    expect(markdownToAdf("")).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph" }],
    });
  });

  it("parses headings", () => {
    const result = markdownToAdf("### Notes");
    expect(result.content?.[0]).toEqual({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Notes" }],
    });
  });

  it("parses a fenced code block with its language", () => {
    const result = markdownToAdf("```ts\nconst a = 1;\n```");
    expect(result.content?.[0]).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const a = 1;" }],
    });
  });

  it("parses bullet and ordered lists into their ADF shapes", () => {
    expect(markdownToAdf("- a\n- b").content?.[0].type).toBe("bulletList");
    expect(markdownToAdf("1. a\n2. b").content?.[0].type).toBe("orderedList");
    expect(markdownToAdf("- a\n- b").content?.[0].content).toHaveLength(2);
  });

  it("parses inline marks, longest delimiter first", () => {
    const result = markdownToAdf("**bold** and *it* and `code`");
    expect(result.content?.[0].content).toEqual([
      { type: "text", text: "bold", marks: [{ type: "strong" }] },
      { type: "text", text: " and " },
      { type: "text", text: "it", marks: [{ type: "em" }] },
      { type: "text", text: " and " },
      { type: "text", text: "code", marks: [{ type: "code" }] },
    ]);
  });

  it("parses a link into a text node with a link mark", () => {
    const result = markdownToAdf("see [docs](https://x.test/a)");
    expect(result.content?.[0].content?.[1]).toEqual({
      type: "text",
      text: "docs",
      marks: [{ type: "link", attrs: { href: "https://x.test/a" } }],
    });
  });

  it("parses a horizontal rule and a blockquote", () => {
    expect(markdownToAdf("---").content?.[0]).toEqual({ type: "rule" });
    expect(markdownToAdf("> quoted").content?.[0].type).toBe("blockquote");
  });

  it("leaves unrecognized syntax as paragraph text rather than dropping it", () => {
    const result = markdownToAdf("| a | b |");
    expect(result.content?.[0].type).toBe("paragraph");
    expect(result.content?.[0].content?.[0].text).toBe("| a | b |");
  });
});

describe("round trip", () => {
  it("preserves the block structure people actually write", () => {
    const source = [
      "# Title",
      "",
      "Some **bold** text with a [link](https://x.test).",
      "",
      "- one",
      "- two",
      "",
      "```sh",
      "echo hi",
      "```",
    ].join("\n");
    expect(adfToMarkdown(markdownToAdf(source))).toBe(source);
  });
});

describe("markdownToRichText", () => {
  it("builds ADF for Cloud and passes the raw string for Data Center", () => {
    expect(markdownToRichText("hi", "cloud")).toMatchObject({ type: "doc" });
    expect(markdownToRichText("hi", "datacenter")).toBe("hi");
  });
});
