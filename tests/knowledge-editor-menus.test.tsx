// @vitest-environment happy-dom
// Contextual editor menus (TipTap BubbleMenu): the fixed toolbar is gone, a
// selection toolbar appears for a text selection, a table menu while the caret
// is in a table, an image menu when an image is selected. Each menu is a
// labelled toolbar reachable by keyboard (Alt+F10 in, arrows across, Esc back).
//
// happy-dom limits: no layout, so Floating UI positions every menu at 0,0 —
// these tests assert which menu is mounted and what its buttons do, not where
// it sits on screen.
import { readFileSync } from "node:fs";
import type { Editor } from "@tiptap/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});

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
  // immediatelyRender: false → the editor is created in an effect.
  await vi.waitFor(() => {
    if (!container.querySelector(".ProseMirror")) throw new Error("no editor");
  });
  const dom = container.querySelector(".ProseMirror") as HTMLElement & {
    editor: Editor;
  };
  return { editor: dom.editor, dom, onChange };
}

/** The menu toolbar with this accessible name, once the BubbleMenu shows it
 *  (the plugin debounces selection updates, so poll). */
async function menu(name: string) {
  let found: HTMLElement | null = null;
  await vi.waitFor(
    () => {
      found = document.querySelector<HTMLElement>(
        `[role="toolbar"][aria-label="${name}"]`
      );
      if (!found) throw new Error(`menu ${name} not shown`);
    },
    { timeout: 2000 }
  );
  return found as unknown as HTMLElement;
}

function toolbars() {
  return Array.from(document.querySelectorAll('[role="toolbar"]')).map((el) =>
    el.getAttribute("aria-label")
  );
}

async function settle() {
  // Longer than BubbleMenu's 250 ms selection debounce.
  await act(() => new Promise((r) => setTimeout(r, 320)));
}

function button(scope: HTMLElement, label: string) {
  const el = scope.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`
  );
  if (!el) throw new Error(`no button ${label}`);
  return el;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.click();
  });
}

async function key(target: Element, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    );
  });
}

/** Document position of the first node of this type. */
function posOf(editor: Editor, type: string) {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at === -1 && node.type.name === type) at = pos;
    return at === -1;
  });
  return at;
}

const SELECTION_BUTTONS = [
  "Bold",
  "Italic",
  "Strikethrough",
  "Inline code",
  "Link",
  "Heading 2",
  "Heading 3",
  "Bullet list",
  "Ordered list",
  "Task list",
  "Quote",
];

describe("editor surface", () => {
  it("renders no fixed toolbar and no undo/redo buttons", async () => {
    await mount({ value: "Hello world" });
    await settle();
    expect(toolbars()).toEqual([]);
    expect(document.querySelector('button[aria-label="Undo"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Redo"]')).toBeNull();
  });

  it("defaults the placeholder to the slash-command hint", async () => {
    const { dom } = await mount({ value: "" });
    expect(
      dom.querySelector("[data-placeholder]")?.getAttribute("data-placeholder")
    ).toBe("Type / for commands");
  });

  it("keeps a caller's placeholder", async () => {
    const { dom } = await mount({ value: "", placeholder: "Start writing…" });
    expect(
      dom.querySelector("[data-placeholder]")?.getAttribute("data-placeholder")
    ).toBe("Start writing…");
  });

  it("is framed by default and frameless with borderless", async () => {
    // Exact class tokens — descendant utilities like [&_td]:border don't count.
    const tokens = (el: HTMLElement) => el.className.split(/\s+/);
    const framed = await mount({ value: "x" });
    expect(tokens(framed.dom)).toEqual(
      expect.arrayContaining(["border", "rounded-md", "bg-background"])
    );
    act(() => root.unmount());
    root = createRoot(container);
    const bare = await mount({ value: "x", borderless: true });
    for (const frame of ["border", "rounded-md", "bg-background", "px-4"]) {
      expect(tokens(bare.dom)).not.toContain(frame);
    }
  });

  it("advertises the menu shortcut on the editing surface", async () => {
    const { dom } = await mount({ value: "x" });
    expect(dom.getAttribute("aria-keyshortcuts")).toBe("Alt+F10");
  });
});

describe("selection toolbar", () => {
  it("appears for a text selection with every labelled control", async () => {
    const { editor } = await mount({ value: "Hello world" });
    await act(async () => {
      editor.chain().focus().setTextSelection({ from: 1, to: 6 }).run();
    });
    const bar = await menu("Formatting");
    for (const label of SELECTION_BUTTONS) {
      expect(button(bar, label)).toBeTruthy();
    }
    expect(toolbars()).toEqual(["Formatting"]);
  });

  it("stays hidden for a collapsed caret", async () => {
    const { editor } = await mount({ value: "Hello world" });
    await act(async () => {
      editor.chain().focus().setTextSelection(3).run();
    });
    await settle();
    expect(toolbars()).toEqual([]);
  });

  it("stays hidden inside a code block", async () => {
    const { editor } = await mount({ value: "```\nconst x = 1;\n```" });
    await act(async () => {
      editor.chain().focus().setTextSelection({ from: 2, to: 7 }).run();
    });
    await settle();
    expect(toolbars()).toEqual([]);
  });

  it.each([
    ["Bold", "**Hello** world"],
    ["Italic", "*Hello* world"],
    ["Strikethrough", "~~Hello~~ world"],
    ["Inline code", "`Hello` world"],
    ["Heading 2", "## Hello world"],
    ["Heading 3", "### Hello world"],
    ["Bullet list", "- Hello world"],
    ["Ordered list", "1. Hello world"],
    ["Task list", "- [ ] Hello world"],
    ["Quote", "> Hello world"],
  ])("%s runs its command", async (label, expected) => {
    const { editor } = await mount({ value: "Hello world" });
    await act(async () => {
      editor.chain().focus().setTextSelection({ from: 1, to: 6 }).run();
    });
    const bar = await menu("Formatting");
    await click(button(bar, label));
    expect(editorMarkdown(editor)).toBe(expected);
  });

  it("applies a link from the link popover", async () => {
    const { editor } = await mount({ value: "Hello world" });
    await act(async () => {
      editor.chain().focus().setTextSelection({ from: 1, to: 6 }).run();
    });
    const bar = await menu("Formatting");
    await click(button(bar, "Link"));
    const input = await vi.waitFor(() => {
      const el = document.querySelector<HTMLInputElement>(
        'input[placeholder="https://example.com"]'
      );
      if (!el) throw new Error("no link input");
      return el;
    });
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      set?.call(input, "example.org/guide");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.form?.requestSubmit();
    });
    expect(editorMarkdown(editor)).toBe(
      "[Hello](https://example.org/guide) world"
    );
  });

  it("links the selection to a document (interim home until the / menu)", async () => {
    const { editor } = await mount({
      value: "Read the guide",
      linkableDocs: [{ title: "Release checklist", slug: "release-checklist" }],
    });
    await act(async () => {
      editor.chain().focus().setTextSelection({ from: 10, to: 15 }).run();
    });
    const bar = await menu("Formatting");
    await click(button(bar, "Link to document"));
    const item = await vi.waitFor(() => {
      const el = Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')
      ).find((n) => n.textContent?.includes("Release checklist"));
      if (!el) throw new Error("no doc item");
      return el;
    });
    await click(item);
    expect(editorMarkdown(editor)).toBe(
      "Read the [guide](/knowledge/release-checklist)"
    );
  });

  it("hides the link-to-document control when there are no documents", async () => {
    const { editor } = await mount({ value: "Hello world" });
    await act(async () => {
      editor.chain().focus().setTextSelection({ from: 1, to: 6 }).run();
    });
    const bar = await menu("Formatting");
    expect(
      bar.querySelector('button[aria-label="Link to document"]')
    ).toBeNull();
  });
});

describe("keyboard reachability", () => {
  it("Alt+F10 moves focus into the menu, arrows move across, Esc returns", async () => {
    const { editor, dom } = await mount({ value: "Hello world" });
    await act(async () => {
      editor.chain().focus().setTextSelection({ from: 1, to: 6 }).run();
    });
    const bar = await menu("Formatting");

    await key(dom, { key: "F10", altKey: true });
    expect(document.activeElement).toBe(button(bar, "Bold"));

    await key(document.activeElement as Element, { key: "ArrowRight" });
    expect(document.activeElement).toBe(button(bar, "Italic"));
    await key(document.activeElement as Element, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(button(bar, "Bold"));
    await key(document.activeElement as Element, { key: "End" });
    expect(document.activeElement).toBe(button(bar, "Quote"));
    await key(document.activeElement as Element, { key: "Home" });
    expect(document.activeElement).toBe(button(bar, "Bold"));

    // The menu stays while focus is inside it.
    await settle();
    expect(toolbars()).toEqual(["Formatting"]);

    await key(document.activeElement as Element, { key: "Escape" });
    // Tiptap's focus command lands on the next animation frame.
    await vi.waitFor(() => expect(editor.view.hasFocus()).toBe(true));
    // Selection is kept, so formatting continues from where it left off.
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6);
  });

  it("arrows follow visual order in RTL", async () => {
    const { editor, dom } = await mount({ value: "Hello world" });
    await act(async () => {
      editor.chain().focus().setTextSelection({ from: 1, to: 6 }).run();
    });
    const bar = await menu("Formatting");
    bar.style.direction = "rtl";
    await key(dom, { key: "F10", altKey: true });
    await key(document.activeElement as Element, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(button(bar, "Italic"));
  });

  it("Alt+F10 with no menu showing leaves focus in the editor", async () => {
    const { editor, dom } = await mount({ value: "Hello world" });
    await act(async () => {
      editor.chain().focus().setTextSelection(3).run();
    });
    await settle();
    await key(dom, { key: "F10", altKey: true });
    expect(editor.view.hasFocus()).toBe(true);
  });
});

const TABLE = "| a | b |\n| --- | --- |\n| 1 | 2 |";

describe("table menu", () => {
  async function caretInTable() {
    const ctx = await mount({ value: `Intro\n\n${TABLE}` });
    // Inside the first body cell's paragraph.
    const cell = posOf(ctx.editor, "tableCell");
    await act(async () => {
      ctx.editor
        .chain()
        .focus()
        .setTextSelection(cell + 2)
        .run();
    });
    return ctx;
  }

  function rows(editor: Editor) {
    let n = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "tableRow") n++;
    });
    return n;
  }

  function columns(editor: Editor) {
    let n = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "tableRow" && n === 0) n = node.childCount;
    });
    return n;
  }

  it("appears while the caret is in a table, alone", async () => {
    await caretInTable();
    const bar = await menu("Table");
    for (const label of [
      "Add row",
      "Delete row",
      "Add column",
      "Delete column",
      "Delete table",
    ]) {
      expect(button(bar, label)).toBeTruthy();
    }
    await settle();
    expect(toolbars()).toEqual(["Table"]);
  });

  it("does not appear outside a table", async () => {
    const { editor } = await mount({ value: `Intro\n\n${TABLE}` });
    await act(async () => {
      editor.chain().focus().setTextSelection(2).run();
    });
    await settle();
    expect(toolbars()).toEqual([]);
  });

  it("gives way to the selection toolbar for selected text in a cell", async () => {
    const { editor } = await caretInTable();
    const cell = posOf(editor, "tableCell");
    await act(async () => {
      editor
        .chain()
        .focus()
        .setTextSelection({ from: cell + 2, to: cell + 3 })
        .run();
    });
    await menu("Formatting");
    await settle();
    expect(toolbars()).toEqual(["Formatting"]);
  });

  it("adds and deletes rows and columns", async () => {
    const { editor } = await caretInTable();
    const bar = await menu("Table");
    expect(rows(editor)).toBe(2);
    await click(button(bar, "Add row"));
    expect(rows(editor)).toBe(3);
    await click(button(await menu("Table"), "Delete row"));
    expect(rows(editor)).toBe(2);
    expect(columns(editor)).toBe(2);
    await click(button(await menu("Table"), "Add column"));
    expect(columns(editor)).toBe(3);
    await click(button(await menu("Table"), "Delete column"));
    expect(columns(editor)).toBe(2);
  });

  it("deletes the table", async () => {
    const { editor } = await caretInTable();
    await click(button(await menu("Table"), "Delete table"));
    expect(posOf(editor, "table")).toBe(-1);
    expect(editorMarkdown(editor)).toBe("Intro");
  });

  it("is keyboard reachable with Alt+F10", async () => {
    const { dom } = await caretInTable();
    const bar = await menu("Table");
    await key(dom, { key: "F10", altKey: true });
    expect(document.activeElement).toBe(button(bar, "Add row"));
  });
});

const IMAGE = "![A diagram](/api/knowledge/asset/abc)";

describe("image menu", () => {
  async function imageSelected() {
    const ctx = await mount({ value: `Intro\n\n${IMAGE}` });
    await act(async () => {
      ctx.editor
        .chain()
        .focus()
        .setNodeSelection(posOf(ctx.editor, "image"))
        .run();
    });
    return ctx;
  }

  it("appears when an image is selected, alone", async () => {
    await imageSelected();
    const bar = await menu("Image");
    expect(button(bar, "Edit alt text")).toBeTruthy();
    expect(button(bar, "Remove image")).toBeTruthy();
    await settle();
    expect(toolbars()).toEqual(["Image"]);
  });

  it("removes the image", async () => {
    const { editor } = await imageSelected();
    await click(button(await menu("Image"), "Remove image"));
    expect(posOf(editor, "image")).toBe(-1);
  });

  it("edits the alt text, prefilled with the current one", async () => {
    const { editor } = await imageSelected();
    await click(button(await menu("Image"), "Edit alt text"));
    const input = await vi.waitFor(() => {
      const el = document.querySelector<HTMLInputElement>(
        'input[placeholder="Describe the image"]'
      );
      if (!el) throw new Error("no alt input");
      return el;
    });
    expect(input.value).toBe("A diagram");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      set?.call(input, "Staging network diagram");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.form?.requestSubmit();
    });
    expect(editorMarkdown(editor)).toBe(
      "Intro\n\n![Staging network diagram](/api/knowledge/asset/abc)"
    );
  });
});

describe("open without edits", () => {
  // The stored (editor-canonical) fixture plus a document ending in an image,
  // which makes TrailingNode append a paragraph on the first transaction.
  const stored = readFileSync(
    "tests/fixtures/knowledge-round-trip.md",
    "utf8"
  ).replace(/\n$/, "");

  it.each([
    ["the fixture", stored],
    ["a document ending in an image", `Intro **bold**\n\n${IMAGE}`],
  ])(
    "never emits onChange for %s while selecting and opening menus",
    async (_name, value) => {
      const { editor, onChange } = await mount({ value });
      await act(async () => {
        editor.chain().focus().setTextSelection({ from: 1, to: 6 }).run();
      });
      await menu("Formatting");
      await act(async () => {
        editor.chain().setNodeSelection(posOf(editor, "image")).run();
      });
      await menu("Image");
      await act(async () => {
        editor.commands.blur();
      });
      await settle();
      expect(onChange).not.toHaveBeenCalled();
    }
  );
});
