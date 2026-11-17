import { z } from "zod";
import { qualifiedEnvName } from "@/lib/nav-path";
import { uuidSchema } from "@/lib/validation";

/**
 * What one question asks about. Chosen per question and stored on its user
 * message: automatic (no project; the assistant picks what to read), a pinned
 * project (its branches) or a pinned environment (its running commits).
 */
export type QuestionContextInput =
  | { kind: "auto" }
  | { kind: "project"; projectId: string }
  | { kind: "environment"; environmentId: string };

export const questionContextInputSchema: z.ZodType<
  QuestionContextInput,
  QuestionContextInput
> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("auto") }),
  z.strictObject({ kind: z.literal("project"), projectId: uuidSchema }),
  z.strictObject({
    kind: z.literal("environment"),
    environmentId: uuidSchema,
  }),
]);

/** A context checked against the caller, with the names stored as snapshots. */
export type QuestionContext =
  | { kind: "auto" }
  | { kind: "project"; projectId: string; projectName: string }
  | {
      kind: "environment";
      environmentId: string;
      environmentName: string;
      projectId: string;
      projectName: string;
    };

/**
 * A pinned project or environment deleted since the question was asked: its
 * id was set null, the name snapshot (`label`) stays. `of` is what was
 * pinned.
 */
export type GoneContext = {
  kind: "gone";
  of: "project" | "environment";
  label: string;
};

export type StoredQuestionContext = QuestionContext | GoneContext;

/** The context columns of a user message. */
export type ContextRow = {
  projectId: string | null;
  projectName: string | null;
  environmentId: string | null;
  environmentName: string | null;
};

/**
 * Stored columns → context. A name without its id is a deleted project or
 * environment; no project and no environment at all is automatic.
 */
export function contextFromRow(row: ContextRow): StoredQuestionContext {
  if (row.environmentName !== null) {
    if (row.environmentId === null || row.projectId === null) {
      return { kind: "gone", of: "environment", label: row.environmentName };
    }
    return {
      kind: "environment",
      environmentId: row.environmentId,
      environmentName: row.environmentName,
      projectId: row.projectId,
      projectName: row.projectName ?? "",
    };
  }
  if (row.projectName !== null) {
    if (row.projectId === null) {
      return { kind: "gone", of: "project", label: row.projectName };
    }
    return {
      kind: "project",
      projectId: row.projectId,
      projectName: row.projectName,
    };
  }
  return { kind: "auto" };
}

/** The stored columns of a checked context (insertTurn). */
export function contextColumns(context: QuestionContext): ContextRow {
  return {
    projectId: context.kind === "auto" ? null : context.projectId,
    projectName: context.kind === "auto" ? null : context.projectName,
    environmentId:
      context.kind === "environment" ? context.environmentId : null,
    environmentName:
      context.kind === "environment" ? context.environmentName : null,
  };
}

/**
 * A user message's context as the chat shows it: what was pinned, its name
 * (null for automatic) and whether it was deleted since. The ids let a
 * client pin the same context again; a deleted one has no id left.
 */
export type MessageContext = {
  kind: "auto" | "project" | "environment";
  label: string | null;
  deleted: boolean;
  projectId: string | null;
  environmentId: string | null;
};

export function messageContextOf(row: ContextRow): MessageContext {
  const context = contextFromRow(row);
  switch (context.kind) {
    case "auto":
      return {
        kind: "auto",
        label: null,
        deleted: false,
        projectId: null,
        environmentId: null,
      };
    case "project":
      return {
        kind: "project",
        label: context.projectName,
        deleted: false,
        projectId: context.projectId,
        environmentId: null,
      };
    case "environment":
      return {
        kind: "environment",
        label: context.environmentName,
        deleted: false,
        projectId: context.projectId,
        environmentId: context.environmentId,
      };
    case "gone":
      return {
        kind: context.of,
        label: context.label,
        deleted: true,
        projectId: row.projectId,
        environmentId: null,
      };
  }
}

/**
 * A question's context as a conversation list names it: an environment with
 * its project ("Kestrel Membership · Dev 1"), as the question bubble does,
 * since every project may have a "Dev"; null for an automatic question.
 */
export function contextListLabel(row: ContextRow): string | null {
  if (row.environmentName !== null && row.projectName) {
    return qualifiedEnvName(row.environmentName, row.projectName);
  }
  return messageContextOf(row).label;
}
