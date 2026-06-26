"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import {
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Bold,
  Code,
  Columns3,
  FileText,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Rows3,
  Strikethrough,
  Table as TableIcon,
  TextCursorInput,
  Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { buildEditorExtensions } from "@/lib/knowledge-editor-extensions";
import { cn } from "@/lib/utils";
import { KNOWLEDGE_IMAGE_MAX_BYTES } from "@/lib/validation";

export type LinkableDoc = { title: string; slug: string };

export type UploadLabels = { button: string; tooLarge: string; failed: string };

export type LinkInputLabels = {
  label: string;
  placeholder: string;
  apply: string;
  remove: string;
};

export type TableLabels = {
  addRow: string;
  deleteRow: string;
  addColumn: string;
  deleteColumn: string;
  deleteTable: string;
};

export type ImageAltLabels = {
  edit: string;
  placeholder: string;
  apply: string;
};

// Add a protocol when the user types a bare host so the href is a valid URL
// rather than a same-page relative path. Leave relative (/…), anchor (#…),
// mailto:, tel: and already-schemed URLs untouched.
function normalizeHref(raw: string): string {
  const url = raw.trim();
  if (url === "") return "";
  if (/^(https?:|mailto:|tel:|\/|#)/i.test(url)) return url;
  return `https://${url}`;
}

// Image files out of a clipboard/drag FileList. The server re-validates by
// sniffing bytes — this is only a fast client-side filter.
function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
}

// Toolbar control: a ghost icon button that flips to `secondary` when its mark
// is active. Avoids pulling in @radix-ui/react-toggle for a one-off toolbar.
function ToolbarButton({
  active,
  onClick,
  label,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant={active ? "secondary" : "ghost"}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </Button>
  );
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
}: {
  value: string;
  linkableDocs?: LinkableDoc[];
  linkLabels?: { title: string; search: string; empty: string };
  linkInputLabels?: LinkInputLabels;
  uploadLabels?: UploadLabels;
  tableLabels?: TableLabels;
  imageAltLabels?: ImageAltLabels;
  onChange: (markdown: string) => void;
  placeholder?: string;
}) {
  // Paste/drop handlers live inside the editor config (set once on mount) but
  // need the latest upload closure — route through a ref reassigned each render.
  const uploadRef = useRef<(file: File) => void>(() => {});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);

  // onChange is debounced: serializing the whole doc to markdown on every
  // keystroke is O(doc) and re-renders the parent form each time. Coalesce to
  // one serialize per idle window; onBlur flushes immediately so a Save click
  // (which blurs the editor first) never reads stale content. Routed through a
  // ref so the latest onChange is always used without re-creating the editor.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The last markdown string we emitted upward. Used to distinguish our own
  // change (which already updated `value`) from a genuine external reset, so
  // the sync effect below never clobbers in-flight typing — see there.
  const lastEmittedRef = useRef(value);

  const editor = useEditor({
    immediatelyRender: false,
    // Extension set lives in lib/knowledge-editor-extensions so the markdown
    // round-trip test builds from the exact same config the editor runs.
    extensions: buildEditorExtensions(placeholder ?? ""),
    content: value,
    // `content` is markdown, not HTML — without this it parses as HTML.
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: cn(
          "min-h-[24rem] rounded-b-md border border-t-0 bg-background px-4 py-3",
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
          "[&_td]:border [&_td]:px-3 [&_td]:py-1.5"
        ),
      },
      // Upload images pasted from the clipboard or dropped into the editor.
      handlePaste: (_view, event) => {
        const files = imageFiles(event.clipboardData?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        for (const f of files) uploadRef.current(f);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = imageFiles((event as DragEvent).dataTransfer?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        for (const f of files) uploadRef.current(f);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = undefined;
        const md = e.getMarkdown();
        lastEmittedRef.current = md;
        onChangeRef.current(md);
      }, 300);
    },
    onBlur: ({ editor: e }) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
        const md = e.getMarkdown();
        lastEmittedRef.current = md;
        onChangeRef.current(md);
      }
    },
  });

  const [pickerOpen, setPickerOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [altOpen, setAltOpen] = useState(false);
  const [altText, setAltText] = useState("");
  const altInputRef = useRef<HTMLInputElement>(null);

  // Reassigned every render so it always closes over the current editor.
  uploadRef.current = async (file: File) => {
    if (!editor) return;
    if (file.size > KNOWLEDGE_IMAGE_MAX_BYTES) {
      if (uploadLabels) toast.error(uploadLabels.tooLarge);
      return;
    }
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/knowledge/asset", {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(String(res.status));
      const { url } = (await res.json()) as { url: string };
      editor.chain().focus().setImage({ src: url, alt: file.name }).run();
    } catch {
      if (uploadLabels) toast.error(uploadLabels.failed);
    }
  };

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
  }, [value, editor]);

  if (!editor) return null;

  // Prefill the popover from the link under the cursor (empty for a new link).
  const onLinkOpenChange = (open: boolean) => {
    if (open) {
      const prev = editor.getAttributes("link").href as string | undefined;
      setLinkUrl(prev ?? "");
    }
    setLinkOpen(open);
  };

  const applyLink = (e?: FormEvent) => {
    e?.preventDefault();
    const href = normalizeHref(linkUrl);
    if (href === "") {
      editor.chain().focus().unsetLink().run();
    } else {
      editor.chain().focus().setLink({ href }).run();
    }
    setLinkOpen(false);
  };

  const removeLink = () => {
    editor.chain().focus().unsetLink().run();
    setLinkOpen(false);
  };

  // Prefill the alt popover from the selected image's current alt text.
  const onAltOpenChange = (open: boolean) => {
    if (open) {
      const alt = editor.getAttributes("image").alt as string | undefined;
      setAltText(alt ?? "");
    }
    setAltOpen(open);
  };

  const applyAlt = (e?: FormEvent) => {
    e?.preventDefault();
    editor.chain().focus().updateAttributes("image", { alt: altText }).run();
    setAltOpen(false);
  };

  // Insert an internal document link as a text node carrying a link mark. The
  // markdown serializer emits `[title](/knowledge/slug)`, which the backlink
  // extractor recognizes — so picking a doc here creates a real backlink edge.
  const insertDocLink = (doc: LinkableDoc) => {
    setPickerOpen(false);
    editor
      .chain()
      .focus()
      .insertContent({
        type: "text",
        text: doc.title,
        marks: [{ type: "link", attrs: { href: `/knowledge/${doc.slug}` } }],
      })
      .run();
  };

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 rounded-t-md border bg-muted/95 p-1 backdrop-blur supports-[backdrop-filter]:bg-muted/80">
        <ToolbarButton
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          label="Bold"
        >
          <Bold className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          label="Italic"
        >
          <Italic className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          label="Strikethrough"
        >
          <Strikethrough className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("heading", { level: 2 })}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
          label="Heading 2"
        >
          <Heading2 className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("heading", { level: 3 })}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 3 }).run()
          }
          label="Heading 3"
        >
          <Heading3 className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          label="Bullet list"
        >
          <List className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          label="Ordered list"
        >
          <ListOrdered className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("codeBlock")}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          label="Code block"
        >
          <Code className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          label="Quote"
        >
          <Quote className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("table")}
          onClick={() =>
            editor
              .chain()
              .focus()
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
              .run()
          }
          label="Insert table"
        >
          <TableIcon className="size-4" />
        </ToolbarButton>
        <Popover open={linkOpen} onOpenChange={onLinkOpenChange}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant={editor.isActive("link") ? "secondary" : "ghost"}
              aria-label={linkInputLabels?.label ?? "Link"}
              aria-pressed={editor.isActive("link")}
            >
              <Link2 className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-80"
            onOpenAutoFocus={(e) => {
              // Focus the input, not the first button.
              e.preventDefault();
              linkInputRef.current?.focus();
            }}
          >
            <form onSubmit={applyLink} className="flex flex-col gap-2">
              <Input
                ref={linkInputRef}
                type="url"
                inputMode="url"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder={
                  linkInputLabels?.placeholder ?? "https://example.com"
                }
              />
              <div className="flex justify-end gap-2">
                {editor.isActive("link") && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={removeLink}
                  >
                    {linkInputLabels?.remove ?? "Remove"}
                  </Button>
                )}
                <Button type="submit" size="sm">
                  {linkInputLabels?.apply ?? "Apply"}
                </Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
        <ToolbarButton
          onClick={() => fileInputRef.current?.click()}
          label={uploadLabels?.button ?? "Insert image"}
        >
          <ImagePlus className="size-4" />
        </ToolbarButton>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            for (const f of imageFiles(e.target.files)) uploadRef.current(f);
            e.target.value = "";
          }}
        />
        {linkableDocs.length > 0 && (
          <ToolbarButton
            onClick={() => setPickerOpen(true)}
            label={linkLabels?.title ?? "Link to document"}
          >
            <FileText className="size-4" />
          </ToolbarButton>
        )}
        {/* Image alt-text editor — only when an image node is selected. Alt
            text is the read-side accessibility/SEO label, so it must be
            editable after the upload-time filename default. */}
        {editor.isActive("image") && (
          <Popover open={altOpen} onOpenChange={onAltOpenChange}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={imageAltLabels?.edit ?? "Edit alt text"}
              >
                <TextCursorInput className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-80"
              onOpenAutoFocus={(e) => {
                e.preventDefault();
                altInputRef.current?.focus();
              }}
            >
              <form onSubmit={applyAlt} className="flex flex-col gap-2">
                <Input
                  ref={altInputRef}
                  value={altText}
                  onChange={(e) => setAltText(e.target.value)}
                  placeholder={
                    imageAltLabels?.placeholder ?? "Describe the image"
                  }
                />
                <div className="flex justify-end">
                  <Button type="submit" size="sm">
                    {imageAltLabels?.apply ?? "Apply"}
                  </Button>
                </div>
              </form>
            </PopoverContent>
          </Popover>
        )}
        {/* Table structure controls — only when the cursor is inside a table.
            Insert-only is not enough: pasted/created tables need row/column
            add + delete and a way to remove the whole table. */}
        {editor.isActive("table") && (
          <>
            <div className="mx-0.5 h-5 w-px bg-border" aria-hidden />
            <ToolbarButton
              onClick={() => editor.chain().focus().addRowAfter().run()}
              label={tableLabels?.addRow ?? "Add row"}
            >
              <BetweenHorizontalEnd className="size-4" />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().deleteRow().run()}
              label={tableLabels?.deleteRow ?? "Delete row"}
            >
              <Rows3 className="size-4" />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().addColumnAfter().run()}
              label={tableLabels?.addColumn ?? "Add column"}
            >
              <BetweenVerticalEnd className="size-4" />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().deleteColumn().run()}
              label={tableLabels?.deleteColumn ?? "Delete column"}
            >
              <Columns3 className="size-4" />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().deleteTable().run()}
              label={tableLabels?.deleteTable ?? "Delete table"}
            >
              <Trash2 className="size-4" />
            </ToolbarButton>
          </>
        )}
      </div>
      <EditorContent editor={editor} />

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
