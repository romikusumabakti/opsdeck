import { describe, expect, it } from "vitest";
import {
  type DraftProjectFacts,
  pickDraftProject,
} from "@/lib/assistant/draft-project";

// The project a new draft is preselected with: the last question's pinned
// project (or its environment's), else the project the last answer read
// most, else a Stage 2 conversation's own project; only ever one the caller
// can see.

const A = "project-a";
const B = "project-b";
const C = "project-c";
const LEGACY = "project-legacy";

const facts = (over: Partial<DraftProjectFacts> = {}): DraftProjectFacts => ({
  lastQuestionProjectId: null,
  answerReads: [],
  answerSources: [],
  conversationProjectId: null,
  ...over,
});
const all = () => true;
const only =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id);

describe("pickDraftProject", () => {
  it("takes the last question's project", () => {
    // A pinned, then B pinned: the latest question decides.
    expect(
      pickDraftProject(
        facts({ lastQuestionProjectId: B, conversationProjectId: A }),
        all
      )
    ).toBe(B);
  });

  it("takes the project the last automatic answer read most", () => {
    expect(pickDraftProject(facts({ answerReads: [A, C, C, A, C] }), all)).toBe(
      C
    );
    // A tie goes to the project read first.
    expect(pickDraftProject(facts({ answerReads: [A, C, C, A] }), all)).toBe(A);
  });

  it("falls back to the answer's sources when no read names a project", () => {
    expect(pickDraftProject(facts({ answerSources: [C, C, A] }), all)).toBe(C);
  });

  it("prefers the answer over a Stage 2 conversation's project for an automatic question", () => {
    expect(
      pickDraftProject(
        facts({ answerReads: [C], conversationProjectId: LEGACY }),
        all
      )
    ).toBe(C);
    expect(
      pickDraftProject(facts({ conversationProjectId: LEGACY }), all)
    ).toBe(LEGACY);
  });

  it("is null when nothing names a project", () => {
    expect(pickDraftProject(facts(), all)).toBeNull();
  });

  it("only ever suggests a project the caller can see", () => {
    expect(
      pickDraftProject(
        facts({
          lastQuestionProjectId: A,
          answerReads: [B, B, C],
          conversationProjectId: LEGACY,
        }),
        only(C, LEGACY)
      )
    ).toBe(C);
    expect(
      pickDraftProject(
        facts({ lastQuestionProjectId: A, conversationProjectId: LEGACY }),
        only(B)
      )
    ).toBeNull();
  });
});
