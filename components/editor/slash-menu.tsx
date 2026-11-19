import { Popover } from "@base-ui/react/popover";
import { type Editor, Extension, type Range } from "@tiptap/core";
import { type EditorState, PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion } from "@tiptap/suggestion";
import {
  FileText,
  Heading2,
  Heading3,
  Image as ImageIcon,
  List,
  ListOrdered,
  ListTodo,
  type LucideIcon,
  Minus,
  Quote,
  SquareCode,
  Table as TableIcon,
} from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore } from "react";

/** The block commands, in menu order. */
export const SLASH_COMMANDS = [
  "heading2",
  "heading3",
  "bulletList",
  "orderedList",
  "taskList",
  "quote",
  "codeBlock",
  "table",
  "image",
  "divider",
  "linkDocument",
] as const;

/** How long "no matching commands" stays up before the menu hides. */
const EMPTY_NOTICE_MS = 1500;

export type SlashCommandId = (typeof SLASH_COMMANDS)[number];

export type SlashLabels = { menu: string; empty: string } & Record<
  SlashCommandId,
  string
>;

const DEFAULT_LABELS: SlashLabels = {
  menu: "Commands",
  empty: "No matching commands",
  heading2: "Heading 2",
  heading3: "Heading 3",
  bulletList: "Bulleted list",
  orderedList: "Numbered list",
  taskList: "Task list",
  quote: "Quote",
  codeBlock: "Code block",
  table: "Table",
  image: "Image",
  divider: "Divider",
  linkDocument: "Link to document",
};

// English names that match in every locale, next to the localized label —
// what people type out of habit from other editors (`/h2`, `/todo`, `/hr`).
const ALIASES: Record<SlashCommandId, string[]> = {
  heading2: ["heading 2", "h2", "title"],
  heading3: ["heading 3", "h3", "subheading"],
  bulletList: ["bulleted list", "bullet", "unordered", "ul"],
  orderedList: ["numbered list", "ordered", "ol"],
  taskList: ["task list", "todo", "checkbox", "checklist"],
  quote: ["quote", "blockquote"],
  codeBlock: ["code block", "codeblock", "pre", "snippet"],
  table: ["table", "grid"],
  image: ["image", "img", "picture", "photo", "upload"],
  divider: ["divider", "hr", "horizontal rule", "separator"],
  linkDocument: ["link to document", "document", "doc", "knowledge"],
};

const ICONS: Record<SlashCommandId, LucideIcon> = {
  heading2: Heading2,
  heading3: Heading3,
  bulletList: List,
  orderedList: ListOrdered,
  taskList: ListTodo,
  quote: Quote,
  codeBlock: SquareCode,
  table: TableIcon,
  image: ImageIcon,
  divider: Minus,
  linkDocument: FileText,
};

// Lowercase without diacritics, so "codigo" finds "Bloque de código".
const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

/**
 * The items whose localized label or English alias contains `query`
 * (case- and accent-insensitive). Ranked: label starts with it, then a word
 * of the label or an alias starts with it, then anywhere; menu order within
 * a rank. An empty query lists everything.
 */
export function filterSlashItems<
  T extends { id: SlashCommandId; label: string },
>(items: T[], query: string): T[] {
  const q = fold(query.trim());
  if (q === "") return items;
  const ranked: { item: T; rank: number }[] = [];
  for (const item of items) {
    const label = fold(item.label);
    const terms = [label, ...ALIASES[item.id]];
    let rank = -1;
    if (label.startsWith(q)) rank = 0;
    else if (terms.some((t) => t.split(/\s+/).some((w) => w.startsWith(q)))) {
      rank = 1;
    } else if (terms.some((t) => t.includes(q))) rank = 2;
    if (rank >= 0) ranked.push({ item, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.item);
}

/**
 * Whether a `/` at `from` may open the menu: at the start of its line (the
 * textblock, or right after a hard break) or after whitespace — not after a
 * word character or a formatted word, so `and/or` and paths stay text — and
 * never in code (a code block, or a `/` carrying an inline code mark).
 */
export function slashAllowed(state: EditorState, from: number): boolean {
  const $from = state.doc.resolve(from);
  if ($from.parent.type.spec.code) return false;
  const slash = state.doc.nodeAt(from);
  if (slash?.marks.some((m) => m.type.spec.code)) return false;
  if ($from.parentOffset === 0) return true;
  const before = $from.parent.textBetween(
    $from.parentOffset - 1,
    $from.parentOffset,
    "\n",
    "\n"
  );
  return /\s/.test(before);
}

/** An open `/` session: the `/query` text's range and where it is drawn. */
export type SlashSession = {
  range: Range;
  query: string;
  clientRect: (() => DOMRect | null) | null;
};

/**
 * Hands the suggestion plugin's state to the React menu and the menu's key
 * handling back to the plugin. One per editor, created before it.
 */
export type SlashStore = ReturnType<typeof createSlashStore>;

export function createSlashStore() {
  let session: SlashSession | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => session,
    set(next: SlashSession | null) {
      session = next;
      for (const l of listeners) l();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Assigned by the mounted menu: true when the key was the menu's. */
    keyDown: (_event: KeyboardEvent): boolean => false,
    /** Assigned by the mounted menu: whether anything is on screen. */
    shown: (): boolean => true,
  };
}

export const slashPluginKey = new PluginKey("slashCommand");

/**
 * The `/` trigger. Rendering is the React `SlashMenu`; this extension only
 * tracks the `/query` (TipTap Suggestion) and forwards keys. The high
 * priority keeps its key handling ahead of every extension keymap wherever it
 * sits in the extension list, so Enter picks a command instead of splitting a
 * list item.
 */
export const SlashCommand = Extension.create<{ store: SlashStore | null }>({
  name: "slashCommand",
  priority: 1000,
  addOptions: () => ({ store: null }),
  addProseMirrorPlugins() {
    const store = this.options.store;
    if (!store) return [];
    const toSession = (p: {
      range: Range;
      query: string;
      clientRect?: (() => DOMRect | null) | null;
    }): SlashSession => ({
      range: p.range,
      query: p.query,
      clientRect: p.clientRect ?? null,
    });
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: slashPluginKey,
        char: "/",
        // slashAllowed checks what precedes the `/` (whitespace, line start,
        // hard break) itself; the default prefix check only knows a space.
        allowedPrefixes: null,
        allow: ({ state, range }) => slashAllowed(state, range.from),
        render: () => ({
          onStart: (p) => store.set(toSession(p)),
          onUpdate: (p) => store.set(toSession(p)),
          onExit: () => store.set(null),
          onKeyDown: ({ event }) => {
            // The plugin closes the menu on Esc and keeps the text; the key
            // must not also close a dialog around the editor — unless nothing
            // was on screen to close (the no-match notice timed out).
            if (event.key === "Escape") {
              if (store.shown()) event.stopPropagation();
              return true;
            }
            if (event.isComposing) return false;
            return store.keyDown(event);
          },
        }),
      }),
    ];
  },
});

type Item = {
  id: SlashCommandId;
  label: string;
  Icon: LucideIcon;
};

/**
 * The `/` command list at the caret: a Base UI popover (same surface as the
 * assistant's mention list) holding a listbox whose highlighted option is the
 * editor's `aria-activedescendant` — focus never leaves the text. ↑/↓ move
 * (wrapping), Enter or Tab runs, Esc closes and leaves the `/query` as typed,
 * a click runs. Aligned to the start of the `/` (right edge in RTL).
 *
 * `onImage` / `onLinkDocument` run after the `/query` is removed; the Link to
 * document item is listed only with `onLinkDocument`.
 */
export function SlashMenu({
  editor,
  store,
  labels = DEFAULT_LABELS,
  onImage,
  onLinkDocument,
}: {
  editor: Editor;
  store: SlashStore;
  labels?: SlashLabels;
  onImage: () => void;
  onLinkDocument?: () => void;
}) {
  const session = useSyncExternalStore(store.subscribe, store.get, store.get);
  const listId = useId();
  const [highlight, setHighlight] = useState({ key: "", index: 0 });

  const all: Item[] = SLASH_COMMANDS.filter(
    (id) => id !== "linkDocument" || onLinkDocument
  ).map((id) => ({ id, label: labels[id], Icon: ICONS[id] }));
  const items = session ? filterSlashItems(all, session.query) : [];
  const key = session ? `${session.range.from}:${session.query}` : "";
  const index =
    highlight.key === key ? Math.min(highlight.index, items.length - 1) : 0;
  const listOpen = session !== null && items.length > 0;
  // "No match" shows briefly, then gets out of the way: typing a path such as
  // `/etc/hosts` at a line start is text, not a failed command.
  const [emptyDone, setEmptyDone] = useState<number | null>(null);
  const emptyAt =
    session !== null && items.length === 0 ? session.range.from : null;
  const open = session !== null && !(emptyAt !== null && emptyDone === emptyAt);
  useEffect(() => {
    if (emptyAt === null) return;
    const timer = setTimeout(() => setEmptyDone(emptyAt), EMPTY_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [emptyAt]);
  const optionId = (i: number) => `${listId}-${i}`;

  const run = (item: Item) => {
    const range = store.get()?.range;
    if (!range) return;
    const chain = editor.chain().focus().deleteRange(range);
    switch (item.id) {
      case "heading2":
        chain.setHeading({ level: 2 }).run();
        return;
      case "heading3":
        chain.setHeading({ level: 3 }).run();
        return;
      case "bulletList":
        chain.toggleBulletList().run();
        return;
      case "orderedList":
        chain.toggleOrderedList().run();
        return;
      case "taskList":
        chain.toggleTaskList().run();
        return;
      case "quote":
        chain.toggleBlockquote().run();
        return;
      case "codeBlock":
        chain.setCodeBlock().run();
        return;
      case "table":
        // Same default the old toolbar used.
        chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
        return;
      case "divider":
        chain.setHorizontalRule().run();
        return;
      case "image":
        chain.run();
        onImage();
        return;
      case "linkDocument":
        chain.run();
        onLinkDocument?.();
        return;
    }
  };

  // The plugin asks the mounted menu about every key while a `/` is open.
  // Assigned in an effect (no ref writes during render).
  useEffect(() => {
    store.keyDown = (event) => {
      if (!listOpen) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const by = event.key === "ArrowDown" ? 1 : -1;
        setHighlight({
          key,
          index: (index + by + items.length) % items.length,
        });
        return true;
      }
      // Ctrl/⌘+Enter is not a pick: it stays the surrounding form's submit.
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        !(event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
      ) {
        const item = items[index];
        if (!item) return false;
        run(item);
        return true;
      }
      return false;
    };
  });
  useEffect(() => {
    store.shown = () => open;
  });
  useEffect(
    () => () => {
      store.keyDown = () => false;
      store.shown = () => true;
    },
    [store]
  );

  // The combobox wiring lives on the editable text, which keeps the focus.
  const activeId = listOpen ? optionId(index) : null;
  useEffect(() => {
    const dom = editor.view.dom;
    const attrs: Record<string, string | null> = {
      "aria-autocomplete": session ? "list" : null,
      "aria-controls": listOpen ? listId : null,
      "aria-activedescendant": activeId,
    };
    for (const [name, value] of Object.entries(attrs)) {
      if (value === null) dom.removeAttribute(name);
      else dom.setAttribute(name, value);
    }
  }, [editor, session, listOpen, listId, activeId]);

  const anchor = session?.clientRect
    ? {
        getBoundingClientRect: () =>
          session.clientRect?.() ?? new DOMRect(0, 0, 0, 0),
      }
    : null;

  return (
    <Popover.Root
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        // A press outside the text and the list closes it (the `/query`
        // stays); Esc is the plugin's.
        if (next || details.reason !== "outside-press") return;
        const target = details.event?.target;
        if (target instanceof Node && editor.view.dom.contains(target)) return;
        if (!editor.isDestroyed) exitSuggestion(editor.view, slashPluginKey);
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={4}
          className="isolate z-50"
        >
          <Popover.Popup
            role="presentation"
            initialFocus={false}
            finalFocus={false}
            className="max-h-[min(20rem,var(--available-height))] w-56 max-w-(--available-width) overflow-y-auto rounded-md bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden"
          >
            {listOpen ? (
              <div
                id={listId}
                role="listbox"
                data-slot="slash-menu"
                aria-label={labels.menu}
              >
                {items.map((item, i) => (
                  <div
                    key={item.id}
                    id={optionId(i)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === index}
                    data-highlighted={i === index ? "" : undefined}
                    // Keeps the focus (and caret) in the text.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => {
                      if (i !== index) setHighlight({ key, index: i });
                    }}
                    onClick={() => run(item)}
                    className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                  >
                    <item.Icon className="text-muted-foreground" aria-hidden />
                    <span className="truncate">{item.label}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p role="status" className="px-2 py-1.5 text-muted-foreground">
                {labels.empty}
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
