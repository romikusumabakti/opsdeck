import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

/**
 * The Tiptap extension set for the knowledge editor. Lives in its own pure
 * module (no JSX, no client-only deps) so it is the SINGLE source of truth for
 * how markdown is parsed and serialized: the editor (`KnowledgeEditor`) and the
 * round-trip fidelity test both build from this exact list. Keep it framework-
 * agnostic — it must import cleanly in a plain Node/jsdom test.
 */
export function buildEditorExtensions(placeholder = "") {
  return [
    // StarterKit v3 already bundles Link and Underline. Configure Link here
    // instead of re-adding the extension (a duplicate would warn and make the
    // openOnClick/autolink config unreliable). Underline is dropped: it has no
    // markdown representation, so the serializer would leak raw <u> HTML.
    StarterKit.configure({
      link: { openOnClick: false, autolink: true },
      underline: false,
    }),
    // StarterKit ships no table node — without this a pasted GFM table
    // collapses to a run-on paragraph and the structure is lost on save.
    // resizable is off: column pixel widths have no GFM representation, so
    // they would silently vanish on save — don't offer a control whose state
    // can't be persisted.
    TableKit.configure({ table: { resizable: false } }),
    // Inline images. Markdown serializes these as ![alt](src); src points at
    // /api/knowledge/asset/<id> (a stable, auth-gated route), never a blob/
    // base64, so the body stays small and portable.
    Image.configure({ inline: false }),
    Placeholder.configure({ placeholder }),
    // First-party markdown serialize/parse, version-locked to @tiptap/core.
    // gfm enables tables/strikethrough; bare-URL autolink is handled by
    // StarterKit's Link (autolink: true) above, so no extra linkify here.
    Markdown.configure({ markedOptions: { gfm: true } }),
  ];
}
