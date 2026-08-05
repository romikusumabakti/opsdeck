"use client";

import { indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useTheme } from "next-themes";
import * as React from "react";
import { cn } from "@/lib/utils";

// CodeMirror 6 wrapped for React. CM owns its own DOM and state — React only
// mounts the view once and pushes configuration changes through Compartments,
// which is CM's supported way to swap part of a live configuration without
// tearing the editor down (and losing cursor, history, and scroll position).

// Token colors reuse the app's existing highlight.js palette (see globals.css)
// rather than shipping a second theme: Lezer tags map onto the same hljs-*
// classes the knowledge editor and markdown render already style, so light/dark
// stays in one place.
const highlightStyle = HighlightStyle.define([
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    class: "hljs-comment",
  },
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.definitionKeyword,
      t.moduleKeyword,
      t.operatorKeyword,
      t.modifier,
      t.self,
    ],
    class: "hljs-keyword",
  },
  { tag: [t.meta, t.processingInstruction, t.annotation], class: "hljs-meta" },
  { tag: [t.tagName, t.angleBracket], class: "hljs-tag" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "hljs-string" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], class: "hljs-number" },
  { tag: [t.inserted], class: "hljs-addition" },
  { tag: [t.deleted], class: "hljs-deletion" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.heading],
    class: "hljs-title",
  },
  {
    tag: [
      t.typeName,
      t.className,
      t.namespace,
      t.attributeName,
      t.propertyName,
      t.variableName,
      t.standard(t.variableName),
    ],
    class: "hljs-attr",
  },
  { tag: [t.link, t.url], class: "hljs-link" },
  { tag: t.emphasis, class: "hljs-emphasis" },
  { tag: t.strong, class: "hljs-strong" },
  { tag: t.invalid, class: "text-destructive" },
]);

// Chrome (gutters, cursor, selection, panels) in app tokens. Colors go through
// CSS variables so a theme switch repaints without rebuilding the extension —
// only CM's own light/dark flag needs reconfiguring.
const baseTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    color: "var(--foreground)",
    backgroundColor: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    lineHeight: "1.6",
  },
  ".cm-content": { padding: "0.5rem 0" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, var(--muted) 60%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent)",
    },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in oklab, var(--primary) 12%, transparent)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--muted)",
    border: "none",
    color: "var(--muted-foreground)",
  },
  ".cm-panels, .cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
});

type Props = {
  // Initial document. Later changes are pushed in only when they differ from
  // what the editor already holds, so typing never fights the prop.
  value: string;
  // Used to pick the language mode; the content itself is never inspected.
  filename: string;
  onChange: (value: string) => void;
  // Fired on Mod-s. Returning nothing is fine — the browser's Save dialog is
  // always suppressed while the editor has focus.
  onSave?: () => void;
  readOnly?: boolean;
  className?: string;
};

export function CodeEditor({
  value,
  filename,
  onChange,
  onSave,
  readOnly = false,
  className,
}: Props) {
  const host = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<EditorView | null>(null);
  const language = React.useRef(new Compartment()).current;
  const editable = React.useRef(new Compartment()).current;
  const darkness = React.useRef(new Compartment()).current;
  const { resolvedTheme } = useTheme();

  // Callbacks live in refs so the view is built exactly once — rebuilding it on
  // every render would reset the document, history, and cursor.
  const onChangeRef = React.useRef(onChange);
  const onSaveRef = React.useRef(onSave);
  React.useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; `value` seeds the doc and is synced by the effect below
  React.useEffect(() => {
    if (!host.current) return;
    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([
            indentWithTab,
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
          ]),
          language.of([]),
          editable.of(EditorState.readOnly.of(readOnly)),
          darkness.of([]),
          syntaxHighlighting(highlightStyle),
          baseTheme,
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
  }, [language, editable, darkness]);

  // Adopt an externally replaced document (a reload, or a different file in the
  // same mounted editor). Skipped while the text matches to avoid clobbering
  // the cursor on every keystroke round-trip.
  React.useEffect(() => {
    const instance = view.current;
    if (!instance || instance.state.doc.toString() === value) return;
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: value },
    });
  }, [value]);

  // Language modes are loaded on demand: @codemirror/language-data resolves the
  // grammar with a dynamic import, so only the modes actually opened ship to
  // the browser.
  React.useEffect(() => {
    let cancelled = false;
    const description = LanguageDescription.matchFilename(languages, filename);
    if (!description) {
      view.current?.dispatch({ effects: language.reconfigure([]) });
      return;
    }
    description.load().then((support) => {
      if (cancelled) return;
      view.current?.dispatch({ effects: language.reconfigure(support) });
    });
    return () => {
      cancelled = true;
    };
  }, [filename, language]);

  React.useEffect(() => {
    view.current?.dispatch({
      effects: editable.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly, editable]);

  // CM needs to know which side of the light/dark split it is on for the parts
  // it styles itself (selection layer defaults, tooltip shadows).
  React.useEffect(() => {
    view.current?.dispatch({
      effects: darkness.reconfigure(
        EditorView.theme({}, { dark: resolvedTheme === "dark" })
      ),
    });
  }, [resolvedTheme, darkness]);

  return (
    <div
      ref={host}
      className={cn("h-full min-h-0 overflow-hidden text-sm", className)}
    />
  );
}
