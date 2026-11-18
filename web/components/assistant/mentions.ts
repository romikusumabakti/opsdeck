import type { QuestionContextInput } from "@/lib/assistant/context";
import type { ContextProject } from "./context-picker";

/** An `@word` being typed: where its `@` is and what follows it. */
export type Mention = { start: number; query: string };

/** A project or environment an `@` can name. */
export type MentionMatch = {
  /** `p:<id>` or `e:<id>`, unique in a list. */
  id: string;
  kind: "project" | "environment";
  /** Shown in the list and put into the text after the `@`. */
  label: string;
  context: QuestionContextInput;
};

const MAX_MATCHES = 8;
// What may stand right before a mention's `@`, besides whitespace and the
// start of the text. Anything else (a letter: `a@b.com`) keeps it text.
const OPENERS = new Set(["(", "[", "{", '"', "'"]);

/**
 * The mention the caret is in: an `@` at the start, after whitespace or an
 * opening bracket or quote, followed up to the caret by no whitespace. Null
 * anywhere else, so `user@example.invalid` stays text.
 */
export function activeMention(text: string, caret: number): Mention | null {
  if (caret < 1) return null;
  const start = text.lastIndexOf("@", caret - 1);
  if (start < 0) return null;
  const query = text.slice(start + 1, caret);
  if (/[\s@]/.test(query)) return null;
  const before = text[start - 1];
  if (before !== undefined && !/\s/.test(before) && !OPENERS.has(before)) {
    return null;
  }
  return { start, query };
}

/** `text` with the mention's `@query` replaced by `@label `, caret after it. */
export function applyMention(
  text: string,
  mention: Mention,
  label: string
): { text: string; caret: number } {
  const inserted = `@${label} `;
  return {
    text:
      text.slice(0, mention.start) +
      inserted +
      text.slice(mention.start + 1 + mention.query.length),
    caret: mention.start + inserted.length,
  };
}

/**
 * The projects, then the environments, whose name or key contains `query`
 * (case-insensitive; an environment also by its project's name or key), at
 * most eight. An empty query lists from the first.
 */
export function mentionMatches(
  projects: readonly ContextProject[],
  query: string
): MentionMatch[] {
  const q = query.toLocaleLowerCase();
  const hit = (...fields: string[]) =>
    fields.some((f) => f.toLocaleLowerCase().includes(q));
  const found: MentionMatch[] = projects
    .filter((p) => hit(p.name, p.key))
    .map((p) => ({
      id: `p:${p.id}`,
      kind: "project",
      label: p.name,
      context: { kind: "project", projectId: p.id },
    }));
  for (const p of projects) {
    for (const e of p.environments) {
      if (hit(e.label, p.key)) {
        found.push({
          id: `e:${e.id}`,
          kind: "environment",
          label: e.label,
          context: { kind: "environment", environmentId: e.id },
        });
      }
    }
  }
  return found.slice(0, MAX_MATCHES);
}
