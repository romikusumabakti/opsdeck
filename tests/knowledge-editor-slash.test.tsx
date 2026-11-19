// @vitest-environment happy-dom
// The `/` command menu (TipTap Suggestion): typing `/` at the start of a line
// or after whitespace lists block commands at the caret; typing filters them,
// arrows move, Enter or a click runs one (removing the `/query` text), Esc
// closes and leaves the text. Never inside code.
//
// happy-dom has no layout, so these tests assert what the menu lists and what
// its commands do to the document and its markdown, not where it sits.
import type { JSONContent } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterSlashItems,
  SLASH_COMMANDS,
} from "@/components/editor/slash-menu";
import { MarkdownEditor } from "@/components/markdown-editor";
import { editorMarkdown } from "@/lib/knowledge-editor-extensions";
import messages from "../messages/en.json";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const DOCS = [
  { title: "Runbook: Rollback", slug: "runbook-rollback" },
  { title: "Onboarding", slug: "onboarding" },
];

async function mount(
  props: Partial<React.ComponentProps<typeof MarkdownEditor>> & {
    value: string;
  }
) {
  const onChange = props.onChange ?? vi.fn();
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <MarkdownEditor {...props} onChange={onChange} />
      </IntlProvider>
    );
  });
  await vi.waitFor(() => {
    if (!container.querySelector(".ProseMirror")) throw new Error("no editor");
  });
  const dom = container.querySelector(".ProseMirror") as HTMLElement & {
    editor: Editor;
  };
  const editor = dom.editor;
  await act(async () => {
    editor.commands.focus("end");
  });
  return { editor, dom, onChange };
}

/** Type text at the caret the way the keyboard would (one transaction per
 *  character, so the suggestion plugin sees each step). */
async function type(editor: Editor, text: string) {
  for (const ch of text) {
    await act(async () => {
      const { state, view } = editor;
      view.dispatch(state.tr.insertText(ch));
    });
  }
}

async function key(target: Element, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    );
  });
}

function listbox() {
  return document.querySelector<HTMLElement>(
    '[role="listbox"][aria-label="Commands"]'
  );
}

async function openList() {
  let found: HTMLElement | null = null;
  await vi.waitFor(() => {
    found = listbox();
    if (!found) throw new Error("slash menu not shown");
  });
  return found as unknown as HTMLElement;
}

function optionLabels() {
  return Array.from(listbox()?.querySelectorAll('[role="option"]') ?? []).map(
    (o) => o.textContent
  );
}

/** Wait a tick for the popover to (not) mount, then assert it is absent. */
async function expectClosed() {
  await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(listbox()).toBeNull();
}

function topTypes(editor: Editor) {
  return (editor.getJSON().content ?? []).map((n) => n.type);
}

describe("slash menu: opening", () => {
  it("opens on `/` in an empty paragraph with every block command", async () => {
    const { editor, dom } = await mount({ value: "", linkableDocs: DOCS });
    await type(editor, "/");
    const list = await openList();
    expect(optionLabels()).toEqual([
      "Heading 2",
      "Heading 3",
      "Bulleted list",
      "Numbered list",
      "Task list",
      "Quote",
      "Code block",
      "Table",
      "Image",
      "Divider",
      "Link to document",
    ]);
    // Focus stays in the text; the highlighted option is its active
    // descendant, like the assistant's mention list.
    const first = list.querySelector('[role="option"]') as HTMLElement;
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(dom.getAttribute("aria-controls")).toBe(list.id);
    expect(dom.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(dom.getAttribute("aria-autocomplete")).toBe("list");
  });

  it("omits Link to document when there are no documents to link", async () => {
    const { editor } = await mount({ value: "" });
    await type(editor, "/");
    await openList();
    expect(optionLabels()).not.toContain("Link to document");
    expect(optionLabels()).toContain("Image");
  });

  it("opens after whitespace in the middle of a line", async () => {
    const { editor } = await mount({ value: "Deploy notes" });
    await type(editor, " /");
    await openList();
  });

  it("does not open after a word character", async () => {
    const { editor } = await mount({ value: "and" });
    await type(editor, "/or");
    await expectClosed();
  });

  it("does not open right after a formatted word (a mark boundary is not whitespace)", async () => {
    const { editor } = await mount({ value: "**bold**" });
    // A plain `/` right after the bold text: its own text node, so the
    // plugin's default check would see no prefix at all and open.
    await act(async () => {
      editor.commands.unsetBold();
    });
    await type(editor, "/");
    expect(editor.getJSON().content?.[0]?.content?.at(-1)).toEqual({
      type: "text",
      text: "/",
    });
    await expectClosed();
  });

  it("does not open inside a code block", async () => {
    const { editor } = await mount({ value: "```\nconst a = 1\n```" });
    await act(async () => {
      editor.commands.setTextSelection(posInside(editor, "codeBlock"));
    });
    await type(editor, " /");
    await expectClosed();
    await type(editor, "\n/");
    await expectClosed();
  });

  it("does not open inside inline code", async () => {
    const { editor } = await mount({ value: "Run `npm test` now" });
    // The caret right after "npm" inside the code span.
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "npm test") at = pos + 3;
    });
    await act(async () => {
      editor.commands.setTextSelection(at);
    });
    await type(editor, " /");
    await expectClosed();
  });

  it("`@` opens nothing in the editor (only `/` is a trigger)", async () => {
    const { editor } = await mount({ value: "" });
    await type(editor, "@");
    await expectClosed();
  });
});

function posInside(editor: Editor, type: string) {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at === -1 && node.type.name === type) at = pos + 1 + node.content.size;
    return at === -1;
  });
  return at;
}

describe("slash menu: filtering and keys", () => {
  it("filters by the typed text", async () => {
    const { editor } = await mount({ value: "" });
    await type(editor, "/num");
    await openList();
    await vi.waitFor(() => expect(optionLabels()).toEqual(["Numbered list"]));
  });

  it("matches English aliases", async () => {
    const { editor } = await mount({ value: "" });
    await type(editor, "/todo");
    await openList();
    await vi.waitFor(() => expect(optionLabels()).toEqual(["Task list"]));
  });

  it("shows a notice with no match and leaves Enter to the editor", async () => {
    const { editor, dom } = await mount({ value: "" });
    await type(editor, "/zzz");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("No matching commands")
    );
    expect(dom.getAttribute("aria-activedescendant")).toBeNull();
    await key(dom, { key: "Enter" });
    expect(editorMarkdown(editor)).toBe("/zzz");
  });

  it("hides the no-match notice after a moment (a typed path is text)", async () => {
    const { editor, dom } = await mount({ value: "" });
    await type(editor, "/etc");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("No matching commands")
    );
    await vi.waitFor(
      () =>
        expect(document.body.textContent).not.toContain("No matching commands"),
      { timeout: 3000 }
    );
    await type(editor, "/hosts");
    expect(document.body.textContent).not.toContain("No matching commands");
    await key(dom, { key: "Enter" });
    expect(editorMarkdown(editor)).toContain("/etc/hosts");
  });

  it("shows the no-match notice again after a match at the same spot", async () => {
    const { editor } = await mount({ value: "" });
    await type(editor, "/zz");
    await vi.waitFor(
      () =>
        expect(document.body.textContent).not.toContain("No matching commands"),
      { timeout: 3000 }
    );
    // Back to a matching query, then a miss again.
    await act(async () => {
      const { state, view } = editor;
      view.dispatch(
        state.tr.delete(state.selection.from - 2, state.selection.from)
      );
    });
    await type(editor, "t");
    await openList();
    await type(editor, "zz");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("No matching commands")
    );
  });

  it("leaves Ctrl/⌘+Enter to the surrounding form", async () => {
    const { editor, dom } = await mount({ value: "" });
    await type(editor, "/");
    await openList();
    await key(dom, { key: "Enter", ctrlKey: true });
    expect(editorMarkdown(editor)).not.toMatch(/^#/);
  });

  it("moves the highlight with the arrows (wrapping) and runs it on Enter", async () => {
    const { editor, dom } = await mount({ value: "" });
    await type(editor, "/");
    const list = await openList();
    const options = () =>
      Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
    await key(dom, { key: "ArrowDown" });
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(dom.getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
    await key(dom, { key: "ArrowUp" });
    await key(dom, { key: "ArrowUp" });
    const last = options().at(-1);
    expect(last?.getAttribute("aria-selected")).toBe("true");
    await key(dom, { key: "ArrowDown" });
    await key(dom, { key: "ArrowDown" });
    await key(dom, { key: "Enter" });
    await type(editor, "Release");
    expect(editorMarkdown(editor)).toBe("### Release");
    await expectClosed();
  });

  it("Esc closes the menu, keeps the typed text and does not bubble", async () => {
    const { editor, dom } = await mount({ value: "" });
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    await type(editor, "/hea");
    await openList();
    await key(dom, { key: "Escape" });
    document.removeEventListener("keydown", outer);
    await expectClosed();
    expect(outer).not.toHaveBeenCalled();
    expect(editorMarkdown(editor)).toBe("/hea");
    // Still dismissed while the same `/word` is being typed.
    await type(editor, "d");
    await expectClosed();
    expect(editorMarkdown(editor)).toBe("/head");
  });

  it("runs a command on click", async () => {
    const { editor } = await mount({ value: "" });
    await type(editor, "/quo");
    await openList();
    const option = listbox()?.querySelector<HTMLElement>('[role="option"]');
    await act(async () => {
      option?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
      option?.click();
    });
    await type(editor, "Ship it");
    expect(editorMarkdown(editor)).toBe("> Ship it");
  });

  it("takes Enter over the list item keymap inside a list", async () => {
    const { editor, dom } = await mount({ value: "- first" });
    await type(editor, " /div");
    await openList();
    await key(dom, { key: "Enter" });
    expect(editorMarkdown(editor)).not.toContain("/div");
    expect(JSON.stringify(editor.getJSON())).toContain("horizontalRule");
  });
});

describe("slash menu: commands", () => {
  // query → markdown after typing "Item" into the new block.
  const TEXT_BLOCKS: [string, string, string][] = [
    ["Heading 2", "/h2", "## Item"],
    ["Heading 3", "/h3", "### Item"],
    ["Bulleted list", "/bullet", "- Item"],
    ["Numbered list", "/numbered", "1. Item"],
    ["Task list", "/task", "- [ ] Item"],
    ["Quote", "/quote", "> Item"],
    ["Code block", "/code", "```\nItem\n```"],
  ];

  for (const [name, query, markdown] of TEXT_BLOCKS) {
    it(`${name} replaces the \`/query\` and yields ${JSON.stringify(markdown)}`, async () => {
      const { editor, dom } = await mount({ value: "" });
      await type(editor, query);
      await openList();
      await vi.waitFor(() => expect(optionLabels()[0]).toBe(name));
      await key(dom, { key: "Enter" });
      await type(editor, "Item");
      expect(editorMarkdown(editor)).toBe(markdown);
    });
  }

  it("Table inserts 3×3 with a header row", async () => {
    const { editor, dom } = await mount({ value: "" });
    await type(editor, "/table");
    await openList();
    await key(dom, { key: "Enter" });
    const table: JSONContent | undefined = editor
      .getJSON()
      .content?.find((n) => n.type === "table");
    expect(table?.content).toHaveLength(3);
    expect(
      table?.content?.[0]?.content?.map((c: JSONContent) => c.type)
    ).toEqual(["tableHeader", "tableHeader", "tableHeader"]);
    expect(table?.content?.[1]?.content).toHaveLength(3);
    expect(editorMarkdown(editor)).not.toContain("/table");
    // The serializer's usual table output (a blank line before it, as the
    // fixtures pin), with nothing left of the `/table`.
    expect(editorMarkdown(editor)).toBe(
      "\n|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n"
    );
  });

  it("Divider inserts a horizontal rule", async () => {
    const { editor, dom } = await mount({ value: "Above" });
    await type(editor, " /divider");
    await openList();
    await key(dom, { key: "Enter" });
    expect(topTypes(editor)).toContain("horizontalRule");
    expect(editorMarkdown(editor)).toMatch(/^Above\s*\n\n---/);
  });

  it("Image removes the `/query` and opens the file picker", async () => {
    const click = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});
    const { editor, dom } = await mount({ value: "" });
    await type(editor, "/image");
    await openList();
    await key(dom, { key: "Enter" });
    expect(click).toHaveBeenCalledTimes(1);
    const input = click.mock.contexts[0] as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/*");
    expect(editorMarkdown(editor)).toBe("");
  });

  it("Link to document opens the doc picker and links the chosen document", async () => {
    const { editor, dom } = await mount({ value: "See ", linkableDocs: DOCS });
    await type(editor, "/link");
    await openList();
    await vi.waitFor(() =>
      expect(optionLabels()).toEqual(["Link to document"])
    );
    await key(dom, { key: "Enter" });
    const item = await vi.waitFor(() => {
      const el = Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')
      ).find((n) => n.textContent?.includes("Onboarding"));
      if (!el) throw new Error("no picker");
      return el;
    });
    await act(async () => {
      item.click();
    });
    expect(editorMarkdown(editor)).toBe(
      "See [Onboarding](/knowledge/onboarding)"
    );
  });

  it("emits the inserted block's markdown through onChange, without the `/query`", async () => {
    const onChange = vi.fn();
    const { editor, dom } = await mount({ value: "", onChange });
    await type(editor, "/h2");
    await openList();
    await key(dom, { key: "Enter" });
    await type(editor, "Plan");
    await act(async () => {
      editor.commands.blur();
    });
    await vi.waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith("## Plan")
    );
    for (const [md] of onChange.mock.calls) expect(md).not.toContain("/");
  });
});

describe("filterSlashItems", () => {
  const items = SLASH_COMMANDS.map((id) => ({
    id,
    label: {
      heading2: "Título 2",
      heading3: "Título 3",
      bulletList: "Lista con viñetas",
      orderedList: "Lista numerada",
      taskList: "Lista de tareas",
      quote: "Cita",
      codeBlock: "Bloque de código",
      table: "Tabla",
      image: "Imagen",
      divider: "Divisor",
      linkDocument: "Enlazar documento",
    }[id],
  }));

  it("matches the localized label, case- and accent-insensitively", () => {
    expect(filterSlashItems(items, "codigo").map((i) => i.id)).toEqual([
      "codeBlock",
    ]);
    expect(filterSlashItems(items, "NUMER").map((i) => i.id)).toEqual([
      "orderedList",
    ]);
  });

  it("matches English aliases in any locale", () => {
    expect(filterSlashItems(items, "divider").map((i) => i.id)).toEqual([
      "divider",
    ]);
    expect(filterSlashItems(items, "h3").map((i) => i.id)).toEqual([
      "heading3",
    ]);
  });

  it("lists everything for an empty query, prefix matches first", () => {
    expect(filterSlashItems(items, "")).toHaveLength(items.length);
    expect(filterSlashItems(items, "ta")[0]?.id).toBe("table");
  });
});
