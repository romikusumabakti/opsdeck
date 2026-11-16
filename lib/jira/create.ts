import { recordActivity } from "@/lib/activity";
import {
  claimIssueCreator,
  findIssueByJiraId,
  findUnlinkedRemote,
  linkDraftIssue,
  loadCreateContext,
  lockDraft,
  recordUnlinkedRemote,
  type Tx,
} from "@/lib/assistant/draft-store";
import { type JiraDraft, jiraDraftSchema } from "@/lib/assistant/drafts";
import { db } from "@/lib/db";
import type { issues } from "@/lib/db/schema";
import {
  ISSUE_JIRA_ID_INDEX,
  insertIssueWithNextNumber,
  uniqueViolationIndex,
} from "@/lib/issue-number";
import { markdownToRichText } from "./adf";
import { addAttribution } from "./attribution";
import { JiraClient, JiraError } from "./client";
import { mapType } from "./mapping";
import { mapRemoteFields, resolveLink, resolveRemoteUser } from "./sync";
import type { JiraCreateMetaField, JiraIssue } from "./types";

/**
 * Creating a Jira issue from an assistant Jira draft. Runs only on a link
 * with `enabled && pushEnabled` (the same switch as the push half), names the
 * real author (the connection posts as one service account), and inserts the
 * local mirror immediately instead of waiting for the next sweep.
 */

export type JiraCreateErrorCode =
  | "assistant.jira_push_disabled"
  | "assistant.draft_already_created"
  | "assistant.invalid_draft";

export class JiraCreateError extends Error {
  constructor(readonly code: JiraCreateErrorCode) {
    super(code);
    this.name = "JiraCreateError";
  }
}

const ACCEPTANCE_CRITERIA = "acceptance criteria";

/** A text field named "Acceptance Criteria" on the create screen, if any. */
export function acceptanceCriteriaField(
  fields: JiraCreateMetaField[]
): JiraCreateMetaField | null {
  return (
    fields.find(
      (f) =>
        f.name.trim().toLowerCase() === ACCEPTANCE_CRITERIA &&
        f.schema?.type === "string"
    ) ?? null
  );
}

function criteriaMarkdown(criteria: string[]): string {
  return criteria.map((c) => `- ${c.replace(/\s*\n\s*/g, " ")}`).join("\n");
}

function joinDescription(description: string, criteria: string[]): string {
  const section =
    criteria.length > 0
      ? `## Acceptance Criteria\n\n${criteriaMarkdown(criteria)}`
      : "";
  return [description.trim(), section].filter((p) => p !== "").join("\n\n");
}

/** The draft's description with its criteria as a list section. */
export function descriptionWithCriteria(draft: JiraDraft): string {
  return joinDescription(draft.description, draft.acceptanceCriteria);
}

/** Jira's limit on a text field such as the description, in characters. */
export const JIRA_TEXT_MAX = 32_767;
/**
 * What the description sent to Jira may take: below JIRA_TEXT_MAX with room
 * for the markdown → rich-text conversion.
 */
export const JIRA_DESCRIPTION_BUDGET = 30_000;
const TRUNCATION_MARK = "\n\n[…]";

const length = (value: string) => Array.from(value).length;

/**
 * The description Jira receives: the attribution line, the draft's
 * description and (unless they go to their own field) the criteria section,
 * within JIRA_DESCRIPTION_BUDGET. When too long, the draft's own description
 * is cut (marked) so the attribution and the criteria stay whole.
 */
export function jiraDescription(
  draft: JiraDraft,
  options: { criteria: boolean; authorName: string | null }
): string {
  const criteria = options.criteria ? draft.acceptanceCriteria : [];
  const wrap = (description: string) => {
    const body = joinDescription(description, criteria);
    return options.authorName ? addAttribution(body, options.authorName) : body;
  };
  const full = wrap(draft.description);
  if (length(full) <= JIRA_DESCRIPTION_BUDGET) return full;
  // wrap("") lacks the separator a non-empty description adds; count it.
  const overhead = length(wrap("")) + 2 + length(TRUNCATION_MARK);
  const keep = Math.max(0, JIRA_DESCRIPTION_BUDGET - overhead);
  const cut = Array.from(draft.description.trim()).slice(0, keep).join("");
  return wrap(`${cut.trimEnd()}${TRUNCATION_MARK}`);
}

/**
 * The create payload. With an "Acceptance Criteria" field the criteria go
 * there (rich text for a paragraph field, plain lines for a single-line one)
 * and stay out of the description.
 */
export function buildCreateFields(params: {
  projectKey: string;
  issueTypeId: string;
  draft: JiraDraft;
  authorName: string | null;
  flavor: "cloud" | "datacenter";
  criteriaField: JiraCreateMetaField | null;
}): Record<string, unknown> {
  const { draft, criteriaField, flavor } = params;
  const useField =
    criteriaField !== null && draft.acceptanceCriteria.length > 0;
  const fields: Record<string, unknown> = {
    project: { key: params.projectKey },
    issuetype: { id: params.issueTypeId },
    summary: draft.summary,
    description: markdownToRichText(
      jiraDescription(draft, {
        criteria: !useField,
        authorName: params.authorName,
      }),
      flavor
    ),
  };
  if (useField && criteriaField) {
    const list = criteriaMarkdown(draft.acceptanceCriteria);
    const paragraph = criteriaField.schema?.custom?.endsWith(":textarea");
    fields[criteriaField.key ?? criteriaField.fieldId] = paragraph
      ? markdownToRichText(list, flavor)
      : draft.acceptanceCriteria.join("; ");
  }
  return fields;
}

type Created = {
  issueId: string;
  number: number;
  jiraKey: string;
  projectKey: string | null;
};

/**
 * Creates the Jira issue for a Jira draft, inserts its local mirror, links
 * the draft and records `issue.created_from_assistant`. The caller has
 * authorized `actorId` on the project.
 *
 * One reviewed request makes at most one Jira issue:
 * - the draft row stays locked throughout, so a second request waits and
 *   then finds the draft created;
 * - the create POST is never re-sent (lib/jira/client.ts, 429 only);
 * - a mirror the webhook sync inserted first is adopted, not duplicated;
 * - if the local write still fails after the Jira issue exists, the issue is
 *   recorded against the draft (UNLINKED_CREATE_ACTION) and the next request
 *   links that issue instead of creating another.
 */
export async function createJiraIssueFromDraft(
  draftId: string,
  actorId: string
): Promise<{ issueId: string; jiraKey: string }> {
  // Set once the Jira issue exists; survives the rollback below.
  let remote: { id: string; key: string } | null = null;
  let recorded = false;
  let created: Created;
  try {
    created = await db.transaction(async (tx) => {
      const draft = await lockDraft(tx, draftId);
      if (draft?.kind !== "jira") {
        throw new JiraCreateError("assistant.invalid_draft");
      }
      if (draft.issueId) {
        throw new JiraCreateError("assistant.draft_already_created");
      }
      const parsed = jiraDraftSchema.safeParse(draft.content);
      if (!parsed.success) throw new JiraCreateError("assistant.invalid_draft");
      const content = parsed.data;

      const resolved = await resolveLink(draft.projectId);
      if (!resolved || !(resolved.link.enabled && resolved.link.pushEnabled)) {
        throw new JiraCreateError("assistant.jira_push_disabled");
      }
      const { link, connection, credentials } = resolved;
      const context = await loadCreateContext(actorId, draft.projectId);
      const client = new JiraClient(credentials);

      let issueTypeName: string = content.issueType;
      const earlier = await findUnlinkedRemote(tx, draftId);
      if (earlier) {
        remote = { id: earlier.jiraIssueId, key: earlier.jiraKey };
        recorded = true;
      } else {
        const meta = await client.getCreateMeta(
          link.jiraProjectKey,
          content.issueType
        );
        if (!meta) {
          throw new Error(
            `Jira project ${link.jiraProjectKey} offers no issue type`
          );
        }
        issueTypeName = meta.issueType.name;
        try {
          remote = await client.createIssue(
            buildCreateFields({
              projectKey: link.jiraProjectKey,
              issueTypeId: meta.issueType.id,
              draft: content,
              authorName: context.actorName,
              flavor: connection.flavor,
              criteriaField: acceptanceCriteriaField(meta.fields),
            })
          );
        } catch (error) {
          // A 400 is Jira rejecting the fields (a required field, a value
          // the project does not allow): nothing was created.
          if (error instanceof JiraError && error.status === 400) {
            console.warn(
              `[assistant] Jira rejected the draft ${draftId}: ${error.message}`
            );
            throw new JiraCreateError("assistant.invalid_draft");
          }
          throw error;
        }
      }
      const { id: jiraIssueId, key: jiraKey } = remote;

      // The created issue as Jira stored it: its status, priority, type and
      // assignee are mirrored with the sync's mapping, and its `updated`
      // makes the webhook echo of this create a stale skip in the sync.
      let readBack: JiraIssue | null = null;
      try {
        readBack = await client.getIssue(jiraIssueId);
      } catch (error) {
        console.warn(
          `[assistant] could not read back ${jiraKey}; using the draft`,
          error
        );
      }
      const mapped = readBack
        ? mapRemoteFields(readBack, link.mappingOverrides)
        : null;
      const now = new Date();
      const issue = await adoptOrInsertMirror(tx, {
        projectId: draft.projectId,
        actorId,
        jiraIssueId,
        values: {
          title: content.summary,
          description: descriptionWithCriteria(content),
          type: mapType(
            readBack?.fields.issuetype?.name ?? issueTypeName,
            link.mappingOverrides
          ),
          ...(mapped
            ? { status: mapped.status, priority: mapped.priority }
            : {}),
          assigneeId: readBack
            ? await resolveRemoteUser(readBack.fields.assignee)
            : null,
          createdById: actorId,
          jiraIssueId,
          jiraKey: readBack?.key ?? jiraKey,
          jiraUpdatedAt: readBack ? new Date(readBack.fields.updated) : now,
          jiraSyncedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
      await linkDraftIssue(tx, draftId, issue.id, now);
      return {
        issueId: issue.id,
        number: issue.number,
        jiraKey: readBack?.key ?? jiraKey,
        projectKey: context.projectKey,
      };
    });
  } catch (error) {
    const left = remote as { id: string; key: string } | null;
    if (left && !recorded) {
      // The Jira issue exists but the transaction rolled back: keep a record
      // against the draft, so the next request links it instead of creating
      // a second one.
      console.error(
        `[assistant] created ${left.key} for draft ${draftId} but could not store it locally`,
        error
      );
      await recordUnlinkedRemote(draftId, actorId, {
        jiraIssueId: left.id,
        jiraKey: left.key,
      }).catch((recordError) => {
        console.error(
          `[assistant] could not record ${left.key} for draft ${draftId}`,
          recordError
        );
      });
    }
    throw error;
  }

  await recordActivity({
    actorId,
    action: "issue.created_from_assistant",
    entityType: "issue",
    entityId: created.issueId,
    data: {
      key: `${created.projectKey ?? ""}-${created.number}`,
      jiraKey: created.jiraKey,
    },
  });
  return { issueId: created.issueId, jiraKey: created.jiraKey };
}

/**
 * The local mirror of `jiraIssueId`: the row the webhook sync already
 * inserted (committed before us, or committing while our insert waits on the
 * unique index), else a new row with the project's next number.
 */
async function adoptOrInsertMirror(
  tx: Tx,
  params: {
    projectId: string;
    actorId: string;
    jiraIssueId: string;
    values: Omit<typeof issues.$inferInsert, "projectId" | "number">;
  }
): Promise<{ id: string; number: number }> {
  const adopt = async (row: { id: string; number: number }) => {
    await claimIssueCreator(tx, row.id, params.actorId);
    return row;
  };
  const existing = await findIssueByJiraId(tx, params.jiraIssueId);
  if (existing) return adopt(existing);
  try {
    return await insertIssueWithNextNumber(tx, params.projectId, params.values);
  } catch (error) {
    if (uniqueViolationIndex(error) !== ISSUE_JIRA_ID_INDEX) throw error;
    // The savepoint rolled back only the insert; the sync's row is
    // committed now, and this new statement sees it.
    const synced = await findIssueByJiraId(tx, params.jiraIssueId);
    if (!synced) throw error;
    return adopt(synced);
  }
}
