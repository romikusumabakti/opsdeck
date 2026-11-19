import type { Editor } from "@tiptap/core";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { GripVertical, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type BlockHandleLabels = { insert: string; drag: string };

const DEFAULT_LABELS: BlockHandleLabels = {
  insert: "Add a block below",
  drag: "Drag to move",
};

/**
 * Opens the `/` menu at a top-level block: in it when it is an empty
 * paragraph, else in a new paragraph right below it. The `/` is real text, so
 * the menu is the same Suggestion session typing `/` starts (Esc leaves it as
 * text, like a typed one).
 */
export function openSlashAtBlock(editor: Editor, node: PMNode, pos: number) {
  if (node.type.name === "paragraph" && node.content.size === 0) {
    editor
      .chain()
      .focus()
      .setTextSelection(pos + 1)
      .insertContent("/")
      .run();
    return;
  }
  const after = pos + node.nodeSize;
  editor
    .chain()
    .focus()
    .insertContentAt(after, {
      type: "paragraph",
      content: [{ type: "text", text: "/" }],
    })
    // Into the new paragraph (+1), after the `/` (+1).
    .setTextSelection(after + 2)
    .run();
}

/**
 * The hover handle beside each top-level block (TipTap's official
 * DragHandle): "+" opens the `/` menu at that block, the grip drags the block
 * to a new place. Both are mouse affordances: they are out of the Tab order
 * and a press keeps the focus (and caret) in the text — the `/` menu is the
 * keyboard path, and the plugin hides the handle on any keystroke. It sits on
 * the inline-start side of the block: left in LTR, right in RTL.
 */
export function BlockHandle({
  editor,
  labels = DEFAULT_LABELS,
}: {
  editor: Editor;
  labels?: BlockHandleLabels;
}) {
  // The block under the pointer; read only on click, so no re-render.
  const target = useRef<{ node: PMNode; pos: number } | null>(null);
  const [rtl, setRtl] = useState(false);
  useEffect(() => {
    const dom = editor.view.dom;
    const dir = dom.closest("[dir]")?.getAttribute("dir");
    setRtl(dir ? dir === "rtl" : getComputedStyle(dom).direction === "rtl");
  }, [editor]);
  // Stable per direction: a new object re-registers the plugin.
  const computePositionConfig = useMemo(
    () => ({
      placement: rtl ? ("right-start" as const) : ("left-start" as const),
      strategy: "absolute" as const,
    }),
    [rtl]
  );

  return (
    <DragHandle
      editor={editor}
      computePositionConfig={computePositionConfig}
      onNodeChange={({ node, pos }) => {
        target.current = node && pos >= 0 ? { node, pos } : null;
      }}
      className="pe-1"
    >
      <div
        data-slot="block-handle"
        className="flex items-center text-muted-foreground"
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label={labels.insert}
          title={labels.insert}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const at = target.current;
            if (!at || editor.isDestroyed) return;
            openSlashAtBlock(editor, at.node, at.pos);
          }}
          className="flex size-5 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground [&_svg]:size-4"
        >
          <Plus aria-hidden />
        </button>
        <div
          data-slot="block-drag-grip"
          title={labels.drag}
          aria-hidden
          className="flex size-5 cursor-grab items-center justify-center rounded-sm hover:bg-muted hover:text-foreground active:cursor-grabbing [&_svg]:size-4"
        >
          <GripVertical />
        </div>
      </div>
    </DragHandle>
  );
}
