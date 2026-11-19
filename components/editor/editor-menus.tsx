import type { EditorState } from "@tiptap/pm/state";
import { NodeSelection, PluginKey, TextSelection } from "@tiptap/pm/state";
import { isInTable } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import { type Editor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Bold,
  Code,
  Columns3,
  FileText,
  Heading2,
  Heading3,
  ImageOff,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Rows3,
  Strikethrough,
  TextCursorInput,
  Trash2,
} from "lucide-react";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipHint } from "@/components/ui/tooltip";

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
  remove: string;
};

export type ToolbarLabels = {
  toolbar: string;
  tableMenu: string;
  imageMenu: string;
  bold: string;
  italic: string;
  strikethrough: string;
  heading2: string;
  heading3: string;
  bulletList: string;
  orderedList: string;
  taskList: string;
  code: string;
  quote: string;
};

/** Keyboard shortcuts that move focus from the text into the visible menu,
 *  in `aria-keyshortcuts` syntax (space-separated alternatives).
 *  - Alt+F10 is the WAI-ARIA / office-suite convention for "focus the
 *    toolbar", but GNOME/Mutter binds it (toggle-maximized) by default, so
 *    on GNOME the page never sees it.
 *  - Ctrl/⌘+Shift+. is the second binding: not taken by GNOME (wm, shell,
 *    media keys), KDE, macOS, Firefox or Chrome, and no TipTap extension in
 *    our set uses it. Either Ctrl or ⌘ works on every platform. */
export const MENU_SHORTCUT = "Alt+F10 Control+Shift+. Meta+Shift+.";

export function isMenuShortcut(event: KeyboardEvent): boolean {
  if (event.key === "F10") {
    return event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  }
  // Physical key: with Shift held `key` is ">" on US layouts.
  const period = event.code === "Period" || event.key === ".";
  return (
    period &&
    event.shiftKey &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey
  );
}

// --- When each menu shows. Pure over the editor state so the three menus can
// --- never claim the same selection (each predicate excludes the others).

/** A non-empty text selection that touches no code block. */
export function showsSelectionMenu(state: EditorState): boolean {
  const { selection, doc } = state;
  if (!(selection instanceof TextSelection) || selection.empty) return false;
  if (doc.textBetween(selection.from, selection.to).length === 0) return false;
  // Hidden as soon as any part of the selection is code: marks and block
  // toggles would mangle or split the code block.
  let touchesCode = Boolean(
    selection.$from.parent.type.spec.code || selection.$to.parent.type.spec.code
  );
  doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.spec.code) touchesCode = true;
    return !touchesCode;
  });
  return !touchesCode;
}

/** The caret (or a cell selection) is inside a table and no text is selected
 *  — selected text in a cell gets the selection toolbar instead. */
export function showsTableMenu(state: EditorState): boolean {
  if (state.selection instanceof NodeSelection) return false;
  if (showsSelectionMenu(state)) return false;
  return isInTable(state);
}

/** An image node is selected. */
export function showsImageMenu(state: EditorState): boolean {
  const { selection } = state;
  return (
    selection instanceof NodeSelection && selection.node.type.name === "image"
  );
}

// A menu stays up while the text or the menu itself holds focus (focus moves
// into it with Alt+F10 or a click), and only for an editable editor.
function focusGate(editor: Editor, view: EditorView, element: HTMLElement) {
  return (
    editor.isEditable &&
    (view.hasFocus() || element.contains(document.activeElement))
  );
}

/** Focus the first enabled control of whichever menu is showing. A hidden
 *  BubbleMenu is detached from the document, so `isConnected` is the
 *  visibility test. Returns false when no menu is up. */
export function focusVisibleMenu(menus: (HTMLElement | null)[]): boolean {
  for (const menu of menus) {
    if (!menu?.isConnected) continue;
    const first = menu.querySelector<HTMLButtonElement>(
      "button:not(:disabled)"
    );
    if (first) {
      first.focus();
      return true;
    }
  }
  return false;
}

/**
 * The surface every contextual menu shares: a BubbleMenu styled as a Base UI
 * popover (same radius, ring, shadow and colours as PopoverContent) holding a
 * WAI-ARIA toolbar. Arrow keys follow visual order (swapped in RTL),
 * Home/End jump to the ends, Escape hands focus back to the text with the
 * selection intact. Buttons keep their natural tab stops.
 */
function EditorMenu({
  editor,
  label,
  shouldShow,
  menuRef,
  placement = "top",
  getReferencedVirtualElement,
  children,
}: {
  editor: Editor;
  label: string;
  shouldShow: (state: EditorState) => boolean;
  menuRef: (el: HTMLDivElement | null) => void;
  placement?: "top" | "top-start";
  getReferencedVirtualElement?: () => {
    getBoundingClientRect: () => DOMRect;
  } | null;
  children: ReactNode;
}) {
  // One key per menu instance: three BubbleMenus share an editor, and the
  // plugin's hide/show metas are addressed by key.
  const [pluginKey] = useState(() => new PluginKey(`editorMenu-${label}`));
  // Created once: BubbleMenu re-sends its options to the plugin (a
  // transaction) whenever these props change identity, so inline objects
  // would dispatch on every parent render.
  const [options] = useState(() => ({ placement, offset: 8 }));
  const [gatedShouldShow] = useState(
    () =>
      ({
        editor: e,
        view,
        state,
        element,
      }: {
        editor: Editor;
        view: EditorView;
        state: EditorState;
        element: HTMLElement;
      }) =>
        focusGate(e, view, element) && shouldShow(state)
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const bar = event.currentTarget;
    // Popovers opened from the menu portal elsewhere in the DOM but bubble
    // through React; their keys (Escape closes the popover) are theirs.
    if (!bar.contains(event.target as Node)) return;
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const buttons = Array.from(
      bar.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")
    );
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement
    );
    if (current === -1) return;
    event.preventDefault();
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else {
      const rtl = getComputedStyle(bar).direction === "rtl";
      const forward = (event.key === "ArrowRight") !== rtl;
      next = forward
        ? (current + 1) % buttons.length
        : (current - 1 + buttons.length) % buttons.length;
    }
    buttons[next]?.focus();
  };

  // Escape is caught in the capture phase: a button's tooltip opens on
  // keyboard focus and its trigger swallows Escape to close itself, which
  // would otherwise cost a second keypress to get back to the text.
  const onKeyDownCapture = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    if (!event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    editor.commands.focus();
  };

  // Tabbing out of the menu to somewhere other than the text or one of the
  // menu's own popovers would otherwise leave it floating until the next
  // transaction (the plugin only hides on the editor's own blur).
  const onBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as HTMLElement | null;
    if (!next) return;
    if (event.currentTarget.contains(next)) return;
    if (editor.view.dom.contains(next)) return;
    if (next.closest("[data-slot=popover-content]")) return;
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(pluginKey, "hide"));
  };

  return (
    <BubbleMenu
      ref={menuRef}
      editor={editor}
      pluginKey={pluginKey}
      className="z-50"
      options={options}
      getReferencedVirtualElement={getReferencedVirtualElement}
      shouldShow={gatedShouldShow}
    >
      <div
        role="toolbar"
        aria-label={label}
        onKeyDown={onKeyDown}
        onKeyDownCapture={onKeyDownCapture}
        onBlur={onBlur}
        className="flex items-center gap-0.5 rounded-md bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      >
        {children}
      </div>
    </BubbleMenu>
  );
}

// Ghost icon button that flips to `secondary` while its format is active.
function MenuButton({
  active,
  onClick,
  label,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <TooltipHint label={label}>
      <Button
        type="button"
        size="icon-sm"
        variant={active ? "secondary" : "ghost"}
        onClick={onClick}
        aria-label={label}
        aria-pressed={active === undefined ? undefined : active}
      >
        {children}
      </Button>
    </TooltipHint>
  );
}

function Separator() {
  return <div className="mx-0.5 h-5 w-px bg-border" aria-hidden />;
}

// Add a protocol when the user types a bare host so the href is a valid URL
// rather than a same-page relative path. Leave relative (/…), anchor (#…),
// mailto:, tel: and already-schemed URLs untouched.
export function normalizeHref(raw: string): string {
  const url = raw.trim();
  if (url === "") return "";
  if (/^(https?:|mailto:|tel:|\/|#)/i.test(url)) return url;
  return `https://${url}`;
}

/** Selection toolbar: marks, link, block type. */
export function SelectionMenu({
  editor,
  labels,
  linkLabels,
  linkDocumentLabel,
  onLinkDocument,
  menuRef,
}: {
  editor: Editor;
  labels?: ToolbarLabels;
  linkLabels?: LinkInputLabels;
  /** Shown only when set — "Link to document" lives here until the `/` menu
   *  takes it over. */
  linkDocumentLabel?: string;
  onLinkDocument?: () => void;
  menuRef: (el: HTMLDivElement | null) => void;
}) {
  // Tiptap v3 does not re-render on transactions; subscribe to the slice the
  // buttons' pressed state reads.
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      taskList: e.isActive("taskList"),
      blockquote: e.isActive("blockquote"),
    }),
  });

  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const linkInputRef = useRef<HTMLInputElement>(null);

  // Prefill from the link under the selection (empty for a new link).
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
      // extendMarkRange: inside an existing link, setLink alone would only
      // touch the selected part — extend to the whole mark so editing the URL
      // replaces it.
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setLinkOpen(false);
  };

  const removeLink = () => {
    editor.chain().focus().unsetLink().run();
    setLinkOpen(false);
  };

  const run = (command: (c: ReturnType<Editor["chain"]>) => unknown) => () => {
    command(editor.chain().focus());
  };

  return (
    <EditorMenu
      editor={editor}
      label={labels?.toolbar ?? "Formatting"}
      shouldShow={showsSelectionMenu}
      menuRef={menuRef}
    >
      <MenuButton
        active={active.bold}
        onClick={run((c) => c.toggleBold().run())}
        label={labels?.bold ?? "Bold"}
      >
        <Bold className="size-4" />
      </MenuButton>
      <MenuButton
        active={active.italic}
        onClick={run((c) => c.toggleItalic().run())}
        label={labels?.italic ?? "Italic"}
      >
        <Italic className="size-4" />
      </MenuButton>
      <MenuButton
        active={active.strike}
        onClick={run((c) => c.toggleStrike().run())}
        label={labels?.strikethrough ?? "Strikethrough"}
      >
        <Strikethrough className="size-4" />
      </MenuButton>
      <MenuButton
        active={active.code}
        onClick={run((c) => c.toggleCode().run())}
        label={labels?.code ?? "Inline code"}
      >
        <Code className="size-4" />
      </MenuButton>
      <Popover open={linkOpen} onOpenChange={onLinkOpenChange}>
        <TooltipHint label={linkLabels?.label ?? "Link"}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant={active.link ? "secondary" : "ghost"}
                aria-label={linkLabels?.label ?? "Link"}
                aria-pressed={active.link}
              />
            }
          >
            <Link2 className="size-4" />
          </PopoverTrigger>
        </TooltipHint>
        <PopoverContent
          align="start"
          className="w-80"
          // Focus the input, not the first button.
          initialFocus={linkInputRef}
        >
          <form onSubmit={applyLink} className="flex flex-col gap-2">
            {/* type="text", not "url": native url validation would block
                submit for exactly the inputs normalizeHref exists to handle
                (bare hosts, relative /paths, #anchors). */}
            <Input
              ref={linkInputRef}
              type="text"
              inputMode="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder={linkLabels?.placeholder ?? "https://example.com"}
            />
            <div className="flex justify-end gap-2">
              {active.link && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={removeLink}
                >
                  {linkLabels?.remove ?? "Remove"}
                </Button>
              )}
              <Button type="submit" size="sm">
                {linkLabels?.apply ?? "Apply"}
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
      {onLinkDocument && linkDocumentLabel && (
        <MenuButton onClick={onLinkDocument} label={linkDocumentLabel}>
          <FileText className="size-4" />
        </MenuButton>
      )}
      <Separator />
      <MenuButton
        active={active.h2}
        onClick={run((c) => c.toggleHeading({ level: 2 }).run())}
        label={labels?.heading2 ?? "Heading 2"}
      >
        <Heading2 className="size-4" />
      </MenuButton>
      <MenuButton
        active={active.h3}
        onClick={run((c) => c.toggleHeading({ level: 3 }).run())}
        label={labels?.heading3 ?? "Heading 3"}
      >
        <Heading3 className="size-4" />
      </MenuButton>
      <MenuButton
        active={active.bulletList}
        onClick={run((c) => c.toggleBulletList().run())}
        label={labels?.bulletList ?? "Bullet list"}
      >
        <List className="size-4" />
      </MenuButton>
      <MenuButton
        active={active.orderedList}
        onClick={run((c) => c.toggleOrderedList().run())}
        label={labels?.orderedList ?? "Ordered list"}
      >
        <ListOrdered className="size-4" />
      </MenuButton>
      <MenuButton
        active={active.taskList}
        onClick={run((c) => c.toggleTaskList().run())}
        label={labels?.taskList ?? "Task list"}
      >
        <ListTodo className="size-4" />
      </MenuButton>
      <MenuButton
        active={active.blockquote}
        onClick={run((c) => c.toggleBlockquote().run())}
        label={labels?.quote ?? "Quote"}
      >
        <Quote className="size-4" />
      </MenuButton>
    </EditorMenu>
  );
}

// Anchor the table menu to the table itself (its top-start corner), not the
// caret, so it doesn't jump around while moving between cells.
function tableAnchor(editor: Editor) {
  return () => {
    const { $anchor } = editor.state.selection;
    for (let depth = $anchor.depth; depth > 0; depth--) {
      if ($anchor.node(depth).type.spec.tableRole !== "table") continue;
      const dom = editor.view.nodeDOM($anchor.before(depth));
      if (dom instanceof HTMLElement) {
        return { getBoundingClientRect: () => dom.getBoundingClientRect() };
      }
    }
    return null;
  };
}

/** Table structure controls while the caret is in a table. */
export function TableMenu({
  editor,
  label,
  labels,
  menuRef,
}: {
  editor: Editor;
  label?: string;
  labels?: TableLabels;
  menuRef: (el: HTMLDivElement | null) => void;
}) {
  const [anchor] = useState(() => tableAnchor(editor));
  const run = (command: (c: ReturnType<Editor["chain"]>) => unknown) => () => {
    command(editor.chain().focus());
  };
  return (
    <EditorMenu
      editor={editor}
      label={label ?? "Table"}
      shouldShow={showsTableMenu}
      menuRef={menuRef}
      placement="top-start"
      getReferencedVirtualElement={anchor}
    >
      <MenuButton
        onClick={run((c) => c.addRowAfter().run())}
        label={labels?.addRow ?? "Add row"}
      >
        <BetweenHorizontalEnd className="size-4" />
      </MenuButton>
      <MenuButton
        onClick={run((c) => c.deleteRow().run())}
        label={labels?.deleteRow ?? "Delete row"}
      >
        <Rows3 className="size-4" />
      </MenuButton>
      <MenuButton
        onClick={run((c) => c.addColumnAfter().run())}
        label={labels?.addColumn ?? "Add column"}
      >
        <BetweenVerticalEnd className="size-4" />
      </MenuButton>
      <MenuButton
        onClick={run((c) => c.deleteColumn().run())}
        label={labels?.deleteColumn ?? "Delete column"}
      >
        <Columns3 className="size-4" />
      </MenuButton>
      <Separator />
      <MenuButton
        onClick={run((c) => c.deleteTable().run())}
        label={labels?.deleteTable ?? "Delete table"}
      >
        <Trash2 className="size-4" />
      </MenuButton>
    </EditorMenu>
  );
}

/** Alt text and removal for a selected image. Alt text is the read-side
 *  accessibility label, so it must be editable after the upload-time filename
 *  default. */
export function ImageMenu({
  editor,
  label,
  labels,
  menuRef,
}: {
  editor: Editor;
  label?: string;
  labels?: ImageAltLabels;
  menuRef: (el: HTMLDivElement | null) => void;
}) {
  const [altOpen, setAltOpen] = useState(false);
  const [altText, setAltText] = useState("");
  const altInputRef = useRef<HTMLInputElement>(null);

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

  return (
    <EditorMenu
      editor={editor}
      label={label ?? "Image"}
      shouldShow={showsImageMenu}
      menuRef={menuRef}
    >
      <Popover open={altOpen} onOpenChange={onAltOpenChange}>
        <TooltipHint label={labels?.edit ?? "Edit alt text"}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={labels?.edit ?? "Edit alt text"}
              />
            }
          >
            <TextCursorInput className="size-4" />
          </PopoverTrigger>
        </TooltipHint>
        <PopoverContent
          align="start"
          className="w-80"
          initialFocus={altInputRef}
        >
          <form onSubmit={applyAlt} className="flex flex-col gap-2">
            <Input
              ref={altInputRef}
              value={altText}
              onChange={(e) => setAltText(e.target.value)}
              placeholder={labels?.placeholder ?? "Describe the image"}
            />
            <div className="flex justify-end">
              <Button type="submit" size="sm">
                {labels?.apply ?? "Apply"}
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
      <MenuButton
        onClick={() => editor.chain().focus().deleteSelection().run()}
        label={labels?.remove ?? "Remove image"}
      >
        <ImageOff className="size-4" />
      </MenuButton>
    </EditorMenu>
  );
}
