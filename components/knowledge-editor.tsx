import { EditorState } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  focusVisibleMenu,
  type ImageAltLabels,
  ImageMenu,
  isMenuShortcut,
  type LinkInputLabels,
  MENU_SHORTCUT,
  SelectionMenu,
  type TableLabels,
  TableMenu,
  type ToolbarLabels,
} from "@/components/editor/editor-menus";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  buildEditorExtensions,
  editorMarkdown,
} from "@/lib/knowledge-editor-extensions";
import {
  addUploadPlaceholder,
  findUploadPlaceholder,
  removeUploadPlaceholder,
  UploadPlaceholder,
} from "@/lib/knowledge-upload-placeholder";
import { cn } from "@/lib/utils";
import { KNOWLEDGE_IMAGE_MAX_BYTES } from "@/lib/validation";

export type {
  ImageAltLabels,
  LinkInputLabels,
  TableLabels,
  ToolbarLabels,
} from "@/components/editor/editor-menus";

export type LinkableDoc = { title: string; slug: string };

export type UploadLabels = {
  button: string;
  uploading: string;
  tooLarge: string;
  failed: string;
};

// Image files out of a clipboard/drag FileList. The server re-validates by
// sniffing bytes — this is only a fast client-side filter.
function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
}

/**
 * TipTap-based markdown editor. The source of truth is markdown: `value` is a
 * markdown string parsed on mount, and `onChange` emits markdown serialized
 * from the document. ProseMirror is only the editing surface — nothing
 * downstream depends on its JSON. Markdown is chosen for portability
 * (git-diffable, exportable) and because backlinks are extracted from its link
 * syntax — it is NOT a stepping stone to real-time collab. Yjs collab would
 * instead need the ProseMirror JSON doc as the shared CRDT type, so this is a
 * deliberate trade-off away from collab, not toward it.
 */
export function KnowledgeEditor({
  value,
  onChange,
  placeholder,
  linkableDocs = [],
  linkLabels,
  linkInputLabels,
  uploadLabels,
  tableLabels,
  imageAltLabels,
  toolbarLabels,
  contentClassName,
  borderless = false,
}: {
  value: string;
  linkableDocs?: LinkableDoc[];
  linkLabels?: { title: string; search: string; empty: string };
  linkInputLabels?: LinkInputLabels;
  uploadLabels?: UploadLabels;
  tableLabels?: TableLabels;
  imageAltLabels?: ImageAltLabels;
  toolbarLabels?: ToolbarLabels;
  onChange: (markdown: string) => void;
  placeholder?: string;
  // Extra classes on the editing surface — merged last, so a min-h/height
  // utility here overrides the default (cn dedupes conflicting classes).
  contentClassName?: string;
  /** No frame (border, radius, background, inline padding) — for surfaces
   *  that sit directly in a page, like an issue description. */
  borderless?: boolean;
}) {
  // Paste/drop handlers live inside the editor config (set once on mount) but
  // need the latest upload closure — route through a ref reassigned each render.
  // `pos` is the document position to insert at (drop point); omitted means the
  // current selection (paste).
  const uploadRef = useRef<(file: File, pos?: number) => void>(() => {});
  // The three contextual menus' root elements, for the Alt+F10 handoff.
  const menusRef = useRef<(HTMLDivElement | null)[]>([null, null, null]);
  const setMenu = (i: number) => (el: HTMLDivElement | null) => {
    menusRef.current[i] = el;
  };

  // onChange is debounced: serializing the whole doc to markdown on every
  // keystroke is O(doc) and re-renders the parent form each time. Coalesce to
  // one serialize per idle window; onBlur flushes immediately so a Save click
  // (which blurs the editor first) never reads stale content. Routed through a
  // ref so the latest onChange is always used without re-creating the editor.
  // The ref write happens in an effect (never during render, per the React
  // rules); events and the debounce timer only read it after effects ran.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The last markdown string we emitted upward. Used to distinguish our own
  // change (which already updated `value`) from a genuine external reset, so
  // the sync effect below never clobbers in-flight typing — see there.
  const lastEmittedRef = useRef(value);

  // Report a new markdown body upward — only when it differs from the last
  // one, so a transaction that leaves the markdown unchanged (a trailing-node
  // insert, a mark toggled and untoggled) never marks the form dirty.
  // Stored bodies saved by the older editor can end in "\n\n" after a final
  // table/image/code block (its TrailingNode paragraph); editorMarkdown no
  // longer emits that, so ignore a difference made only of trailing newlines
  // too — otherwise merely opening such a document would mark it dirty.
  const emit = (md: string) => {
    const last = lastEmittedRef.current;
    if (md === last || md === last.replace(/\n+$/, "")) return;
    lastEmittedRef.current = md;
    onChangeRef.current(md);
  };

  const editor = useEditor({
    immediatelyRender: false,
    // Extension set lives in lib/knowledge-editor-extensions so the markdown
    // round-trip test builds from the exact same config the editor runs.
    // UploadPlaceholder is appended here, outside that shared set: it is pure
    // view decoration (in-flight upload widgets) and never touches the
    // markdown contract the test pins.
    extensions: [
      ...buildEditorExtensions(placeholder ?? ""),
      UploadPlaceholder,
    ],
    content: value,
    // `content` is markdown, not HTML — without this it parses as HTML.
    contentType: "markdown",
    editorProps: {
      attributes: {
        // Screen readers announce how to reach the contextual menus.
        "aria-keyshortcuts": MENU_SHORTCUT,
        class: cn(
          "min-h-[24rem]",
          borderless ? "py-1" : "rounded-md border bg-background px-4 py-3",
          "text-sm leading-relaxed focus:outline-none",
          // Inline structural styles — no typography plugin in this project.
          "[&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:mt-6 [&_h1]:mb-2",
          "[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2",
          "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2",
          "[&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
          "[&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5",
          "[&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-muted-foreground",
          "[&_pre]:bg-muted/50 [&_pre]:border [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-sm [&_pre]:my-3",
          "[&_code]:font-mono [&_code]:text-sm",
          "[&_a]:text-primary [&_a]:underline",
          "[&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-md [&_img]:border",
          "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm",
          "[&_th]:border [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium",
          "[&_td]:border [&_td]:px-3 [&_td]:py-1.5",
          // Task lists: hide the disc marker (the checkbox is the marker) and
          // lay each item out as checkbox + content.
          "[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-1",
          "[&_ul[data-type=taskList]_li]:flex [&_ul[data-type=taskList]_li]:items-start [&_ul[data-type=taskList]_li]:gap-2",
          "[&_ul[data-type=taskList]_li_>_label]:mt-0.5 [&_ul[data-type=taskList]_li_>_div_>_p]:my-0",
          "[&_ul[data-type=taskList]_input]:accent-primary",
          contentClassName
        ),
      },
      // Alt+F10 or Ctrl/⌘+Shift+. moves focus into whichever contextual menu
      // is showing; with
      // none up the key falls through to the browser.
      handleKeyDown: (_view, event) => {
        if (!isMenuShortcut(event)) return false;
        if (!focusVisibleMenu(menusRef.current)) return false;
        event.preventDefault();
        return true;
      },
      // Upload images pasted from the clipboard or dropped into the editor.
      handlePaste: (_view, event) => {
        const files = imageFiles(event.clipboardData?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        for (const f of files) uploadRef.current(f);
        return true;
      },
      handleDrop: (view, event) => {
        const drag = event as DragEvent;
        const files = imageFiles(drag.dataTransfer?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        // Insert at the drop point, not wherever the cursor happens to be.
        const pos = view.posAtCoords({
          left: drag.clientX,
          top: drag.clientY,
        })?.pos;
        for (const f of files) uploadRef.current(f, pos);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = undefined;
        emit(editorMarkdown(e));
      }, 300);
    },
    onBlur: ({ editor: e }) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
        emit(editorMarkdown(e));
      }
    },
  });

  const [pickerOpen, setPickerOpen] = useState(false);

  // Reassigned after every render (in an effect — ref writes during render
  // break React's purity rules) so it always closes over the current editor.
  useEffect(() => {
    uploadRef.current = async (file: File, pos?: number) => {
      if (!editor) return;
      if (file.size > KNOWLEDGE_IMAGE_MAX_BYTES) {
        if (uploadLabels) toast.error(uploadLabels.tooLarge);
        return;
      }
      // A widget decoration marks the insert point while the upload is in
      // flight: a dimmed blob-URL preview of the image. The document itself is
      // untouched until the server URL exists, so a save mid-upload can never
      // persist a blob: src; and because decorations map through edits, the
      // image lands where the placeholder is by then, not at a stale offset.
      const id = {};
      const previewUrl = URL.createObjectURL(file);
      addUploadPlaceholder(editor.view, {
        id,
        pos: pos ?? editor.state.selection.from,
        previewUrl,
        label: uploadLabels?.uploading ?? "Uploading…",
      });
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch("/api/knowledge/asset", {
          method: "POST",
          body: form,
        });
        if (!res.ok) throw new Error(String(res.status));
        const { url } = (await res.json()) as { url: string };
        if (editor.isDestroyed) return;
        const at = findUploadPlaceholder(editor.state, id);
        removeUploadPlaceholder(editor.view, id);
        // Placeholder gone means the user deleted that region mid-upload —
        // honor the deletion and drop the result.
        if (at === null) return;
        editor
          .chain()
          .focus()
          .insertContentAt(at, {
            type: "image",
            attrs: { src: url, alt: file.name },
          })
          .run();
      } catch {
        if (!editor.isDestroyed) removeUploadPlaceholder(editor.view, id);
        if (uploadLabels) toast.error(uploadLabels.failed);
      } finally {
        URL.revokeObjectURL(previewUrl);
      }
    };
  });

  // Drop a pending debounced onChange on unmount so it can't fire after the
  // editor is torn down.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Sync external value resets (e.g. revision restore in the same view) without
  // clobbering the cursor during normal typing. A `value` that equals what we
  // last emitted is just our own change echoing back — ignore it. Re-parsing
  // the live doc to compare would race: chars typed between emit and this
  // effect would make `current` newer than `value` and trigger a setContent
  // that discards them and jumps the cursor. Gating on lastEmittedRef means we
  // only ever reset for a value the editor did NOT produce.
  useEffect(() => {
    if (!editor) return;
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    editor.commands.setContent(value, {
      contentType: "markdown",
      emitUpdate: false,
    });
    // An external reset is a new baseline: rebuild the ProseMirror state with
    // the same doc + plugins so all plugin state (undo history included)
    // starts fresh. Otherwise Ctrl+Z after a revision restore would step back
    // across the restore into the pre-restore document. Tiptap v3 exposes no
    // clear-history command, so this state swap is the canonical route.
    editor.view.updateState(
      EditorState.create({
        doc: editor.state.doc,
        selection: editor.state.selection,
        plugins: editor.state.plugins,
      })
    );
  }, [value, editor]);

  // null only on the first client render, before the editor instance exists.
  if (!editor) return null;

  // Link the selected text to an internal document, or insert the document's
  // title as the link text at a collapsed caret. Either way the serializer
  // emits `[text](/knowledge/slug)`, which the backlink extractor recognizes —
  // so picking a doc here creates a real backlink edge.
  const insertDocLink = (doc: LinkableDoc) => {
    setPickerOpen(false);
    const href = `/knowledge/${doc.slug}`;
    if (!editor.state.selection.empty) {
      editor.chain().focus().setLink({ href }).run();
      return;
    }
    editor
      .chain()
      .focus()
      .insertContent({
        type: "text",
        text: doc.title,
        marks: [{ type: "link", attrs: { href } }],
      })
      .run();
  };

  // Formatting lives in contextual menus (TipTap BubbleMenus) instead of a
  // fixed toolbar: a selection toolbar for selected text, a table menu while
  // the caret is in a table, an image menu for a selected image. Undo/redo
  // stay on their keyboard shortcuts (Mod+Z / Mod+Shift+Z).
  return (
    <div className="flex flex-col">
      <EditorContent editor={editor} />
      <SelectionMenu
        editor={editor}
        labels={toolbarLabels}
        linkLabels={linkInputLabels}
        // Until the `/` menu exists, "Link to document" rides on the selection
        // toolbar so the doc picker stays reachable.
        linkDocumentLabel={linkLabels?.title ?? "Link to document"}
        onLinkDocument={
          linkableDocs.length > 0 ? () => setPickerOpen(true) : undefined
        }
        menuRef={setMenu(0)}
      />
      <TableMenu
        editor={editor}
        label={toolbarLabels?.tableMenu}
        labels={tableLabels}
        menuRef={setMenu(1)}
      />
      <ImageMenu
        editor={editor}
        label={toolbarLabels?.imageMenu}
        labels={imageAltLabels}
        menuRef={setMenu(2)}
      />

      <CommandDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={linkLabels?.title ?? "Link to document"}
        description={linkLabels?.title ?? "Link to document"}
      >
        <CommandInput placeholder={linkLabels?.search ?? "Search documents…"} />
        <CommandList>
          <CommandEmpty>{linkLabels?.empty ?? "No documents"}</CommandEmpty>
          <CommandGroup>
            {linkableDocs.map((doc) => (
              <CommandItem
                key={doc.slug}
                value={`${doc.title} ${doc.slug}`}
                onSelect={() => insertDocLink(doc)}
              >
                <FileText className="text-muted-foreground" />
                <span className="truncate">{doc.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </div>
  );
}
