import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/**
 * In-flight image-upload placeholders for the knowledge editor, as ProseMirror
 * widget decorations (the canonical upload pattern from the ProseMirror
 * examples). Decorations live outside the document, which buys two things:
 *
 *  - the doc is never mutated until the server URL exists, so a save (or the
 *    debounced onChange) during an upload can't leak a blob:/temporary src
 *    into the persisted markdown;
 *  - decoration positions map through every transaction, so the finished
 *    image lands where the placeholder sits NOW, even if the user typed above
 *    it while the upload was in flight — no manual position clamping.
 *
 * Identity is by object reference: the caller mints `const id = {}` per
 * upload and uses it to find/remove its own placeholder.
 */

const uploadPlaceholderKey = new PluginKey<DecorationSet>(
  "knowledgeUploadPlaceholder"
);

type AddAction = {
  add: { id: object; pos: number; previewUrl: string; label: string };
};
type RemoveAction = { remove: { id: object } };

// Rendered lazily (widget factory) so this module stays importable in plain
// Node — no DOM is touched until the editor view actually draws.
function renderPlaceholder(previewUrl: string, label: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className =
    "my-3 animate-pulse rounded-md border border-dashed bg-muted/30 p-2";
  const img = document.createElement("img");
  img.src = previewUrl;
  img.alt = "";
  img.className = "max-w-full rounded-md opacity-50";
  const caption = document.createElement("div");
  caption.className = "mt-1 text-xs text-muted-foreground";
  caption.textContent = label;
  wrap.append(img, caption);
  return wrap;
}

export const UploadPlaceholder = Extension.create({
  name: "knowledgeUploadPlaceholder",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: uploadPlaceholderKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            set = set.map(tr.mapping, tr.doc);
            const action = tr.getMeta(uploadPlaceholderKey) as
              | AddAction
              | RemoveAction
              | undefined;
            if (action && "add" in action) {
              const { id, pos, previewUrl, label } = action.add;
              const widget = Decoration.widget(
                pos,
                () => renderPlaceholder(previewUrl, label),
                { id }
              );
              set = set.add(tr.doc, [widget]);
            } else if (action && "remove" in action) {
              set = set.remove(
                set.find(
                  undefined,
                  undefined,
                  (spec) => spec.id === action.remove.id
                )
              );
            }
            return set;
          },
        },
        props: {
          decorations(state) {
            return uploadPlaceholderKey.getState(state);
          },
        },
      }),
    ];
  },
});

export function addUploadPlaceholder(
  view: EditorView,
  opts: { id: object; pos: number; previewUrl: string; label: string }
) {
  view.dispatch(view.state.tr.setMeta(uploadPlaceholderKey, { add: opts }));
}

export function removeUploadPlaceholder(view: EditorView, id: object) {
  view.dispatch(
    view.state.tr.setMeta(uploadPlaceholderKey, { remove: { id } })
  );
}

/** Current (mapped) position of the placeholder, or null if it was deleted
 *  out from under the upload (e.g. select-all + delete while in flight). */
export function findUploadPlaceholder(
  state: EditorState,
  id: object
): number | null {
  const found = uploadPlaceholderKey
    .getState(state)
    ?.find(undefined, undefined, (spec) => spec.id === id);
  return found?.[0]?.from ?? null;
}
