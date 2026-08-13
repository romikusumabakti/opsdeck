import type { AdfNode } from "./types";

/**
 * Atlassian Document Format ⇄ Markdown.
 *
 * Jira Cloud's v3 API takes and returns ADF for every rich-text field, while
 * OpsDeck stores Markdown. This is the bridge. It is deliberately a small,
 * in-repo converter rather than a dependency: the `@atlaskit/*` packages pull
 * in an entire editor, and the standalone md↔adf packages are unmaintained.
 *
 * Coverage is the set of nodes people actually write in an issue description:
 * paragraphs, headings, both list kinds (nested), code blocks, blockquotes,
 * rules, tables, hard breaks, and the strong/em/code/strike/link marks.
 * Anything else degrades to its text content instead of being dropped — a
 * status report pasted from Confluence loses its panel border, not its words.
 *
 * Pure and dependency-free so it can be unit-tested directly (tests/jira-adf).
 */

// ---------------------------------------------------------------- ADF → MD

/** Render one text node with its marks applied, innermost-first. */
function renderText(node: AdfNode): string {
  const value = node.text ?? "";
  const marks = node.marks ?? [];
  const has = (type: string) => marks.some((m) => m.type === type);

  let out: string;
  if (has("code")) {
    // Inline code is literal: other marks inside it would render as characters
    // in Markdown too, so applying them would change the text.
    out = `\`${value}\``;
  } else {
    out = value;
    if (has("strong")) out = `**${out}**`;
    if (has("em")) out = `*${out}*`;
    if (has("strike")) out = `~~${out}~~`;
  }

  const link = marks.find((m) => m.type === "link");
  const href = link?.attrs?.href;
  if (typeof href === "string" && href.length > 0) out = `[${out}](${href})`;
  return out;
}

/** Flatten a node's children to a single inline string. */
function renderInline(nodes: AdfNode[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return renderText(node);
        case "hardBreak":
          return "  \n";
        case "mention": {
          const label = node.attrs?.text;
          return typeof label === "string" ? label : "@unknown";
        }
        case "emoji": {
          const shortName = node.attrs?.shortName;
          const emojiText = node.attrs?.text;
          if (typeof emojiText === "string") return emojiText;
          return typeof shortName === "string" ? shortName : "";
        }
        case "inlineCard": {
          const url = node.attrs?.url;
          return typeof url === "string" ? url : "";
        }
        default:
          // Unknown inline node: keep whatever text it carries.
          return renderInline(node.content) || (node.text ?? "");
      }
    })
    .join("");
}

/** Table cells must stay on one line and not break the pipe delimiters. */
function renderCell(node: AdfNode): string {
  return (node.content ?? [])
    .map((child) => renderInline(child.content))
    .join(" ")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .trim();
}

function renderTable(node: AdfNode): string {
  const rows = (node.content ?? []).filter((r) => r.type === "tableRow");
  if (rows.length === 0) return "";
  const cells = rows.map((row) => (row.content ?? []).map(renderCell));
  const width = Math.max(...cells.map((r) => r.length));
  const pad = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;

  // GFM requires a header row. ADF tables often have none, so the first row is
  // promoted — losing a border beats emitting an unparseable table.
  const [header, ...body] = cells;
  return [
    // `cells` is non-empty (rows.length === 0 returned above), so the fallback
    // is unreachable — it just spares the assertion.
    pad(header ?? []),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map(pad),
  ].join("\n");
}

/**
 * Render a list, recursing for nesting. `marker` returns the bullet or number
 * for an item; `indent` is the accumulated prefix of enclosing levels.
 */
function renderList(node: AdfNode, ordered: boolean, indent: string): string {
  const items = (node.content ?? []).filter((n) => n.type === "listItem");
  return items
    .map((item, index) => {
      const marker = ordered ? `${index + 1}. ` : "- ";
      const children = item.content ?? [];
      const lines: string[] = [];
      for (const child of children) {
        if (child.type === "bulletList" || child.type === "orderedList") {
          lines.push(
            renderList(
              child,
              child.type === "orderedList",
              `${indent}${" ".repeat(marker.length)}`
            )
          );
          continue;
        }
        const rendered = renderBlock(child, indent);
        if (rendered.length > 0) lines.push(rendered);
      }
      const [first = "", ...rest] = lines.join("\n").split("\n");
      // The marker replaces the indent on the first line; continuation lines
      // are indented to align under the item's text.
      return [
        `${indent}${marker}${first.trimStart()}`,
        ...rest.map((line) => (line.length > 0 ? line : "")),
      ].join("\n");
    })
    .join("\n");
}

function renderBlock(node: AdfNode, indent = ""): string {
  switch (node.type) {
    case "paragraph":
      return indent + renderInline(node.content);
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      const hashes = "#".repeat(Math.min(Math.max(level, 1), 6));
      return `${hashes} ${renderInline(node.content)}`;
    }
    case "bulletList":
      return renderList(node, false, indent);
    case "orderedList":
      return renderList(node, true, indent);
    case "codeBlock": {
      const language = node.attrs?.language;
      const lang = typeof language === "string" ? language : "";
      const body = (node.content ?? []).map((c) => c.text ?? "").join("");
      return `\`\`\`${lang}\n${body}\n\`\`\``;
    }
    case "blockquote":
      return (node.content ?? [])
        .map((child) => renderBlock(child))
        .join("\n")
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
    case "rule":
      return "---";
    case "table":
      return renderTable(node);
    case "mediaGroup":
    case "mediaSingle":
      // Attachments are not mirrored (they stay in Jira); leave a marker rather
      // than a broken image reference.
      return "_[attachment in Jira]_";
    default: {
      // Panels, expands, layouts, and anything Atlassian ships next: keep the
      // content, drop the container.
      const children = node.content ?? [];
      if (children.length === 0) return node.text ?? "";
      return children.map((child) => renderBlock(child, indent)).join("\n\n");
    }
  }
}

/** Convert an ADF document to Markdown. */
export function adfToMarkdown(doc: AdfNode | null | undefined): string {
  if (!doc) return "";
  const blocks = doc.type === "doc" ? (doc.content ?? []) : [doc];
  return blocks
    .map((block) => renderBlock(block))
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim();
}

/**
 * Normalize whichever rich-text shape the deployment returned. Cloud (v3)
 * sends an ADF object; Data Center (v2) sends a wiki-markup string, which we
 * store as-is — close enough to Markdown for headings, lists, and emphasis,
 * and lossless in the round trip since we send it back unchanged.
 */
export function richTextToMarkdown(
  value: string | AdfNode | null | undefined
): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return adfToMarkdown(value);
}

// ---------------------------------------------------------------- MD → ADF

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```(\w*)\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Inline Markdown → ADF text nodes. Handles the four marks Jira renders the
 * same way we do; anything else stays literal text, which is what a Markdown
 * reader would show anyway.
 *
 * Order matters: code first (its contents are literal), then links, then the
 * emphasis marks by decreasing delimiter length so `**` never matches as two
 * `*`.
 */
function parseInline(text: string): AdfNode[] {
  const pattern =
    /(`[^`]+`)|(\[[^\]]*\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*]+\*)|(_[^_]+_)/;
  const nodes: AdfNode[] = [];
  let rest = text;

  while (rest.length > 0) {
    const match = pattern.exec(rest);
    if (!match || match.index === undefined) break;
    if (match.index > 0) {
      nodes.push({ type: "text", text: rest.slice(0, match.index) });
    }
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push({
        type: "text",
        text: token.slice(1, -1),
        marks: [{ type: "code" }],
      });
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      nodes.push({
        type: "text",
        text: label.length > 0 ? label : href,
        marks: [{ type: "link", attrs: { href } }],
      });
    } else if (token.startsWith("**")) {
      nodes.push({
        type: "text",
        text: token.slice(2, -2),
        marks: [{ type: "strong" }],
      });
    } else if (token.startsWith("~~")) {
      nodes.push({
        type: "text",
        text: token.slice(2, -2),
        marks: [{ type: "strike" }],
      });
    } else {
      nodes.push({
        type: "text",
        text: token.slice(1, -1),
        marks: [{ type: "em" }],
      });
    }
    rest = rest.slice(match.index + token.length);
  }

  if (rest.length > 0) nodes.push({ type: "text", text: rest });
  // ADF rejects a paragraph whose content is an empty array; callers filter
  // those out, but an all-whitespace line still needs a node.
  return nodes;
}

function paragraph(text: string): AdfNode {
  return { type: "paragraph", content: parseInline(text) };
}

/**
 * Convert Markdown to an ADF document.
 *
 * A line-oriented parser over the block grammar OpsDeck's editor emits. It is
 * not a CommonMark implementation and does not try to be: unrecognized syntax
 * survives as paragraph text, so the worst case is a lost bold, never a lost
 * sentence.
 */
export function markdownToAdf(markdown: string): AdfNode {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const content: AdfNode[] = [];
  let paragraphBuffer: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return;
    content.push(paragraph(paragraphBuffer.join(" ").trim()));
    paragraphBuffer = [];
  };

  // Every `lines[i]` below sits behind an `i < lines.length` bound, so the
  // `?? ""` fallbacks never fire. They stand in for assertions: an empty line
  // is already this parser's "nothing here" value, so if a future edit does
  // walk off the end the result is a lost blank line, not a crash mid-sync.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (/^```/.test(next)) break;
        body.push(next);
        i++;
      }
      content.push({
        type: "codeBlock",
        attrs: fence[1] ? { language: fence[1] } : {},
        // An empty code block must have no content array, not an empty text node.
        ...(body.length > 0
          ? { content: [{ type: "text", text: body.join("\n") }] }
          : {}),
      });
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      content.push({ type: "rule" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      content.push({
        type: "heading",
        // Both groups in HEADING are unconditional, so these fall back only if
        // the pattern itself changes. Level 1 is the safest such default.
        attrs: { level: heading[1]?.length ?? 1 },
        content: parseInline(heading[2] ?? ""),
      });
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i] ?? "");
        if (!q) break;
        quoted.push(q[1] ?? "");
        i++;
      }
      i--;
      content.push({
        type: "blockquote",
        content: [paragraph(quoted.join(" ").trim())],
      });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      flushParagraph();
      const ordered = ORDERED.test(line);
      const items: AdfNode[] = [];
      while (i < lines.length) {
        const candidate = lines[i] ?? "";
        const m = ordered ? ORDERED.exec(candidate) : BULLET.exec(candidate);
        if (!m) break;
        items.push({
          type: "listItem",
          content: [paragraph(m[2] ?? "")],
        });
        i++;
      }
      i--;
      content.push({
        type: ordered ? "orderedList" : "bulletList",
        ...(ordered ? { attrs: { order: 1 } } : {}),
        content: items,
      });
      continue;
    }

    paragraphBuffer.push(line);
  }
  flushParagraph();

  // ADF requires at least one block; an empty description is one empty
  // paragraph, which is also what Jira's own editor produces.
  return {
    type: "doc",
    version: 1,
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  } as AdfNode;
}

/**
 * Build the rich-text payload for a write, in the shape the deployment
 * expects: ADF on Cloud, the raw string on Data Center.
 */
export function markdownToRichText(
  markdown: string,
  flavor: "cloud" | "datacenter"
): unknown {
  return flavor === "cloud" ? markdownToAdf(markdown) : markdown;
}
