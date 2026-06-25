"use client";

import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  FileText,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Table as TableIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "tiptap-markdown";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { KNOWLEDGE_IMAGE_MAX_BYTES } from "@/lib/validation";

export type LinkableDoc = { title: string; slug: string };

export type UploadLabels = { button: string; tooLarge: string; failed: string };

// tiptap-markdown adds `markdown` to editor.storage at runtime but ships no v3
// type augmentation; read it through this narrow accessor instead of `any`.
function getMarkdownSource(editor: Editor): string {
  return (
    editor.storage as unknown as { markdown: { getMarkdown: () => string } }
  ).markdown.getMarkdown();
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
 * downstream depends on its JSON, which keeps storage portable and makes a
 * future move to real-time collab (Yjs) a drop-in.
 */
export function KnowledgeEditor({
  value,
  onChange,
  placeholder,
  linkableDocs = [],
  linkLabels,
  uploadLabels,
}: {
  value: string;
  linkableDocs?: LinkableDoc[];
  linkLabels?: { title: string; search: string; empty: string };
  uploadLabels?: UploadLabels;
  onChange: (markdown: string) => void;
  placeholder?: string;
}) {
  // Paste/drop handlers live inside the editor config (set once on mount) but
  // need the latest upload closure — route through a ref reassigned each render.
  const uploadRef = useRef<(file: File) => void>(() => {});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      // StarterKit ships no table node — without this a pasted GFM table
      // collapses to a run-on paragraph and the structure is lost on save.
      TableKit.configure({ table: { resizable: true } }),
      // Inline images. Markdown serializes these as ![alt](src); src points at
      // /api/knowledge/asset/<id> (a stable, auth-gated route), never a blob/
      // base64, so the body stays small and portable.
      Image.configure({ inline: false }),
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      Markdown.configure({ transformPastedText: true, linkify: true }),
    ],
    content: value,
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
      onChange(getMarkdownSource(e));
    },
  });

  const [pickerOpen, setPickerOpen] = useState(false);

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

  // Sync external value resets (e.g. revision restore in the same view) without
  // clobbering the cursor during normal typing.
  useEffect(() => {
    if (!editor) return;
    const current = getMarkdownSource(editor);
    if (value !== current) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [value, editor]);

  if (!editor) return null;

  const setLink = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("URL", prev ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().setLink({ href: url }).run();
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
        <ToolbarButton
          active={editor.isActive("link")}
          onClick={setLink}
          label="Link"
        >
          <Link2 className="size-4" />
        </ToolbarButton>
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
