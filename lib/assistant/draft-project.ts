/**
 * The project a new draft is preselected with (the user can change it on the
 * draft). Pure, so the order is tested without a database; the facts come
 * from lib/assistant/draft-store.ts (suggestDraftProject).
 */

export type DraftProjectFacts = {
  /** The project the latest question pinned (or its environment's). */
  lastQuestionProjectId: string | null;
  /**
   * The projects the latest finished answer's code tools read (automatic
   * context), one entry per call, in call order.
   */
  answerReads: string[];
  /** The projects of that answer's sources, in order. */
  answerSources: string[];
  /** A Stage 2 conversation's own project. */
  conversationProjectId: string | null;
};

/** The ids by how often they occur, a tie going to the one seen first. */
function byFrequency(ids: string[]): string[] {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  // Map keys keep first-seen order and the sort is stable.
  return [...counts.keys()].sort(
    (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0)
  );
}

/**
 * The last question's project, else the project the last answer read most
 * (its tool calls, else its sources), else a Stage 2 conversation's project;
 * the first of them the caller can see (`sees`), else null.
 */
export function pickDraftProject(
  facts: DraftProjectFacts,
  sees: (projectId: string) => boolean
): string | null {
  const candidates = [
    facts.lastQuestionProjectId,
    ...byFrequency(facts.answerReads),
    ...byFrequency(facts.answerSources),
    facts.conversationProjectId,
  ];
  return candidates.find((id): id is string => id !== null && sees(id)) ?? null;
}
