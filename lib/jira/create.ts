import { recordActivity } from "@/lib/activity";
import {
  linkDraftIssue,
  loadCreateContext,
  lockDraft,
} from "@/lib/assistant/draft-store";
import { type JiraDraft, jiraDraftSchema } from "@/lib/assistant/drafts";
import { db } from "@/lib/db";
import { insertIssueWithNextNumber } from "@/lib/issue-number";
import { markdownToRichText } from "./adf";
import { addAttribution } from "./attribution";
import { JiraClient } from "./client";
import { mapType } from "./mapping";
import { resolveLink } from "./sync";
import type { JiraCreateMetaField } from "./types";

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

/** The draft's description with its criteria as a list section. */
export function descriptionWithCriteria(draft: JiraDraft): string {
  if (draft.acceptanceCriteria.length === 0) return draft.description;
  const list = criteriaMarkdown(draft.acceptanceCriteria);
  return [draft.description.trim(), `## Acceptance Criteria\n\n${list}`]
    .filter((part) => part !== "")
    .join("\n\n");
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
  const body = useField ? draft.description : descriptionWithCriteria(draft);
  const fields: Record<string, unknown> = {
    project: { key: params.projectKey },
    issuetype: { id: params.issueTypeId },
    summary: draft.summary,
    description: markdownToRichText(
      params.authorName ? addAttribution(body, params.authorName) : body,
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

/**
 * Creates the Jira issue for a Jira draft, inserts its local mirror, links
 * the draft and records `issue.created_from_assistant`. The draft row stays
 * locked throughout, so a second request for the same draft waits and then
 * sees it created. The caller has authorized `actorId` on the project.
 */
export async function createJiraIssueFromDraft(
  draftId: string,
  actorId: string
): Promise<{ issueId: string; jiraKey: string }> {
  const created = await db.transaction(async (tx) => {
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
    const meta = await client.getCreateMeta(
      link.jiraProjectKey,
      content.issueType
    );
    if (!meta)
      throw new Error(
        `Jira project ${link.jiraProjectKey} offers no issue type`
      );
    const remote = await client.createIssue(
      buildCreateFields({
        projectKey: link.jiraProjectKey,
        issueTypeId: meta.issueType.id,
        draft: content,
        authorName: context.actorName,
        flavor: connection.flavor,
        criteriaField: acceptanceCriteriaField(meta.fields),
      })
    );

    // The created issue's own `updated`, so the webhook echo of this create
    // is a stale skip in the sync; now() if Jira cannot be read back.
    let jiraUpdatedAt = new Date();
    try {
      const after = await client.getIssue(remote.id);
      jiraUpdatedAt = new Date(after.fields.updated);
    } catch (error) {
      console.warn(
        `[assistant] could not read back ${remote.key}; using now`,
        error
      );
    }

    try {
      const now = new Date();
      const issue = await insertIssueWithNextNumber(tx, draft.projectId, {
        title: content.summary,
        description: descriptionWithCriteria(content),
        type: mapType(meta.issueType.name, link.mappingOverrides),
        createdById: actorId,
        jiraIssueId: remote.id,
        jiraKey: remote.key,
        jiraUpdatedAt,
        jiraSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await linkDraftIssue(tx, draftId, issue.id, now);
      return {
        issueId: issue.id,
        number: issue.number,
        jiraKey: remote.key,
        projectKey: context.projectKey,
      };
    } catch (error) {
      // The Jira issue exists; the next sweep mirrors it even though the
      // draft stays unlinked.
      console.error(
        `[assistant] created ${remote.key} but could not store it locally`,
        error
      );
      throw error;
    }
  });

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
