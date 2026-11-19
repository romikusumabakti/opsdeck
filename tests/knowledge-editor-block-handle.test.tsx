// @vitest-environment happy-dom
// The block handle beside each top-level block: "+" opens the `/` menu at the
// hovered block (in it when it is an empty paragraph, else in a new paragraph
// right below), without taking focus from the text; the grip is the drag
// source of TipTap's DragHandle. The placeholder hint follows the caret to any
// empty line.
//
// happy-dom has no layout, so the official DragHandle (which finds the block
// under the pointer by coordinates) is replaced by a stub that renders its
// children and lets the test report the hovered block. Hover, drag and the
// visible hint run against the real extension in e2e/editor-block-handle.spec.ts.
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "@/components/markdown-editor";
import arMessages from "../messages/ar.json";
import messages from "../messages/en.json";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type HandleProps = {
  editor: Editor;
  children: ReactNode;
  className?: string;
  computePositionConfig?: { placement?: string };
  onNodeChange?: (data: {
    node: PMNode | null;
    editor: Editor;
    pos: number;
  }) => void;
};

const handle = vi.hoisted(() => ({
  props: null as unknown as HandleProps,
}));

vi.mock("@tiptap/extension-drag-handle-react", () => ({
  DragHandle: (props: HandleProps) => {
    handle.props = props;
    return (
      <div data-testid="drag-handle" className={props.className}>
        {props.children}
      </div>
    );
  },
}));

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
  document.documentElement.removeAttribute("dir");
  vi.restoreAllMocks();
});

async function mount(
  value: string,
  locale: "en" | "ar" = "en",
  placeholder?: string
) {
  await act(async () => {
    root.render(
      <IntlProvider
        locale={locale}
        messages={locale === "ar" ? arMessages : messages}
      >
        <MarkdownEditor
          value={value}
          onChange={vi.fn()}
          placeholder={placeholder}
        />
      </IntlProvider>
    );
  });
  await vi.waitFor(() => {
    if (!container.querySelector(".ProseMirror")) throw new Error("no editor");
  });
  const dom = container.querySelector(".ProseMirror") as HTMLElement & {
    editor: Editor;
  };
  return { editor: dom.editor, dom };
}

/** Report block `index` (top level) as the hovered one, like the plugin's
 *  mousemove does. */
async function hover(editor: Editor, index: number) {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
  await act(async () => {
    handle.props.onNodeChange?.({
      node: editor.state.doc.child(index),
      editor,
      pos,
    });
  });
}

function plusButton() {
  return document.querySelector<HTMLButtonElement>(
    'button[aria-label="Add a block below"]'
  );
}

async function clickPlus() {
  const button = plusButton();
  if (!button) throw new Error("no + button");
  await act(async () => {
    button.click();
  });
}

function listbox() {
  return document.querySelector<HTMLElement>(
    '[role="listbox"][aria-label="Commands"]'
  );
}

async function openList() {
  await vi.waitFor(() => {
    if (!listbox()) throw new Error("slash menu not shown");
  });
}

const texts = (editor: Editor) => {
  const out: string[] = [];
  editor.state.doc.forEach((n) => {
    out.push(n.textContent);
  });
  return out;
};

describe("block handle", () => {
  it("renders a + button and a drag grip inside TipTap's DragHandle", async () => {
    await mount("First\n\nSecond");
    const root = document.querySelector('[data-testid="drag-handle"]');
    expect(root).not.toBeNull();
    expect(root?.contains(plusButton())).toBe(true);
    expect(root?.querySelector('[data-slot="block-drag-grip"]')).not.toBeNull();
    // Mouse affordances: typing never tabs into them (the `/` menu is the
    // keyboard path), and a press does not move focus out of the text.
    expect(plusButton()?.tabIndex).toBe(-1);
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    plusButton()?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("+ on a text block opens the / menu in a new paragraph below it", async () => {
    const { editor } = await mount("First\n\nSecond\n\nThird");
    await hover(editor, 1);
    await clickPlus();
    await openList();
    expect(texts(editor)).toEqual(["First", "Second", "/", "Third"]);
    // The caret sits right after the new `/`, so typing filters the menu.
    const { $from } = editor.state.selection;
    expect($from.parent.textContent).toBe("/");
    expect($from.parentOffset).toBe(1);
    expect(editor.view.hasFocus()).toBe(true);
  });

  it("+ on an empty paragraph opens the / menu in that paragraph", async () => {
    const { editor } = await mount("First");
    await act(async () => {
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: "paragraph",
      });
    });
    await hover(editor, 1);
    await clickPlus();
    await openList();
    expect(texts(editor)).toEqual(["First", "/"]);
  });

  it("+ below a non-text block (a code block) still adds a paragraph", async () => {
    const { editor } = await mount("```\nconst a = 1\n```\n\nAfter");
    await hover(editor, 0);
    await clickPlus();
    await openList();
    expect((editor.getJSON().content ?? []).map((n) => n.type)).toEqual([
      "codeBlock",
      "paragraph",
      "paragraph",
    ]);
    expect(texts(editor)[1]).toBe("/");
  });

  it("+ with no hovered block does nothing", async () => {
    const { editor } = await mount("First");
    await act(async () => {
      handle.props.onNodeChange?.({ node: null, editor, pos: -1 });
    });
    await clickPlus();
    expect(texts(editor)).toEqual(["First"]);
    expect(listbox()).toBeNull();
  });

  it("a framed surface holds it in its padding; a borderless one keeps the text column", async () => {
    const { dom } = await mount("First");
    expect(dom.className.split(/\s+/)).toContain("ps-9");
    // Framed: shown at every width, hidden on touch only.
    const framedHandle = container.querySelector('[data-testid="drag-handle"]');
    expect(framedHandle?.className.split(/\s+/)).toContain(
      "pointer-coarse:hidden"
    );
    expect(framedHandle?.className.split(/\s+/)).not.toContain("max-lg:hidden");
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages}>
          <MarkdownEditor value="First" onChange={vi.fn()} borderless />
        </IntlProvider>
      );
    });
    await vi.waitFor(() => {
      const bare = container.querySelector(".ProseMirror");
      if (!bare) throw new Error("no editor");
      // No inline padding: the handle hangs in the container's margin.
      expect(bare.className).not.toMatch(/(^|\s)(ps|px|pl)-/);
    });
    // Borderless: that margin exists from lg up; never on touch.
    const bareHandle = container.querySelector('[data-testid="drag-handle"]');
    expect(bareHandle?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["max-lg:hidden", "pointer-coarse:hidden"])
    );
  });

  it("sits on the inline-start side: left in LTR, right in RTL", async () => {
    await mount("First");
    expect(handle.props.computePositionConfig?.placement).toBe("left-start");
    act(() => root.unmount());
    root = createRoot(container);
    document.documentElement.setAttribute("dir", "rtl");
    await mount("First", "ar");
    await vi.waitFor(() =>
      expect(handle.props.computePositionConfig?.placement).toBe("right-start")
    );
    // Localized labels.
    expect(
      document.querySelector(
        `button[aria-label="${arMessages.knowledge.blockInsert}"]`
      )
    ).not.toBeNull();
  });
});

describe("placeholder hint on the current empty line", () => {
  it("marks the empty line holding the caret mid-document, and only it", async () => {
    // A caller's own placeholder is for the empty document; an empty line
    // in a written one always gets the `/` hint.
    const { editor, dom } = await mount(
      "First\n\nSecond",
      "en",
      "Start writing…"
    );
    await act(async () => {
      // An empty paragraph between the two, caret in it.
      editor
        .chain()
        .focus()
        .insertContentAt(editor.state.doc.child(0).nodeSize, {
          type: "paragraph",
        })
        .setTextSelection(editor.state.doc.child(0).nodeSize + 1)
        .run();
    });
    const marked = dom.querySelectorAll("[data-placeholder]");
    expect(marked).toHaveLength(1);
    expect(marked[0]?.tagName).toBe("P");
    expect(marked[0]?.textContent).toBe("");
    expect(marked[0]?.getAttribute("data-placeholder")).toBe(
      "Type / for commands"
    );
    expect(marked[0]?.classList.contains("is-empty")).toBe(true);
  });

  it("keeps a caller's placeholder for the empty document", async () => {
    const { dom } = await mount("", "en", "Start writing…");
    expect(
      dom.querySelector("[data-placeholder]")?.getAttribute("data-placeholder")
    ).toBe("Start writing…");
  });
});
