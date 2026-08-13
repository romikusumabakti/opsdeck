import { z } from "zod";

/**
 * Zod shapes for the slice of the Jira REST API we consume.
 *
 * Deliberately narrow and permissive: every object is `.loose()` (unknown keys
 * pass through) and everything we don't strictly need is optional/nullable.
 * Jira adds fields constantly and a strict schema would turn a harmless new
 * key into a failed sync. What IS pinned is the handful of fields the mapper
 * reads — if `fields.updated` or `id` goes missing, failing loudly is correct.
 */

/**
 * Atlassian Document Format node. Recursive and open-ended by design — the
 * converter in ./adf.ts walks it structurally and degrades unknown node types
 * to their text content, so there is nothing to gain from enumerating types.
 */
export type AdfNode = {
  type: string;
  // Only the top-level "doc" node carries this; markdownToAdf emits version 1.
  version?: number;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

export const adfNodeSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z
    .object({
      type: z.string(),
      text: z.string().optional(),
      content: z.array(adfNodeSchema).optional(),
      attrs: z.record(z.string(), z.unknown()).optional(),
      marks: z
        .array(
          z
            .object({
              type: z.string(),
              attrs: z.record(z.string(), z.unknown()).optional(),
            })
            .loose()
        )
        .optional(),
    })
    .loose()
);

/**
 * A rich-text field. Jira Cloud (API v3) returns ADF; Data Center (API v2)
 * returns a wiki-markup string. Both shapes are accepted and normalized by
 * ./adf.ts#richTextToMarkdown, which is why this is a union rather than two
 * client code paths.
 */
export const jiraRichTextSchema = z
  .union([z.string(), adfNodeSchema])
  .nullish();

export const jiraUserSchema = z
  .object({
    accountId: z.string().optional(),
    // Data Center has no accountId; `name` (username) is its stable handle.
    name: z.string().optional(),
    emailAddress: z.string().nullish(),
    displayName: z.string().nullish(),
  })
  .loose();

export const jiraStatusSchema = z
  .object({
    name: z.string(),
    statusCategory: z
      .object({
        // "new" | "indeterminate" | "done" — the stable, workflow-independent
        // grouping. Names are renamed freely by admins; keys are not.
        key: z.string(),
      })
      .loose()
      .optional(),
  })
  .loose();

export const jiraIssueSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    fields: z
      .object({
        summary: z.string().nullish(),
        description: jiraRichTextSchema,
        // ISO 8601 with offset, e.g. 2026-08-11T10:22:31.000+0700.
        updated: z.string(),
        created: z.string().nullish(),
        status: jiraStatusSchema.nullish(),
        issuetype: z.object({ name: z.string() }).loose().nullish(),
        priority: z.object({ name: z.string() }).loose().nullish(),
        assignee: jiraUserSchema.nullish(),
        reporter: jiraUserSchema.nullish(),
        labels: z.array(z.string()).nullish(),
        parent: z.object({ id: z.string(), key: z.string() }).loose().nullish(),
        fixVersions: z.array(z.object({ name: z.string() }).loose()).nullish(),
      })
      .loose(),
  })
  .loose();

export type JiraIssue = z.infer<typeof jiraIssueSchema>;

export const jiraCommentSchema = z
  .object({
    id: z.string(),
    body: jiraRichTextSchema,
    author: jiraUserSchema.nullish(),
    created: z.string().nullish(),
    updated: z.string().nullish(),
  })
  .loose();

export type JiraComment = z.infer<typeof jiraCommentSchema>;

export const jiraCommentPageSchema = z
  .object({ comments: z.array(jiraCommentSchema).default([]) })
  .loose();

/** Cloud's `/search/jql`: token cursor. `isLast` is absent on older responses. */
export const jiraSearchPageSchema = z
  .object({
    issues: z.array(jiraIssueSchema).default([]),
    nextPageToken: z.string().nullish(),
    isLast: z.boolean().nullish(),
    // Data Center's offset paging.
    startAt: z.number().nullish(),
    maxResults: z.number().nullish(),
    total: z.number().nullish(),
  })
  .loose();

export const jiraMyselfSchema = z
  .object({
    accountId: z.string().optional(),
    name: z.string().optional(),
    displayName: z.string().nullish(),
    emailAddress: z.string().nullish(),
  })
  .loose();

export const jiraProjectSchema = z
  .object({ id: z.string(), key: z.string(), name: z.string() })
  .loose();

export const jiraTransitionsSchema = z
  .object({
    transitions: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            to: jiraStatusSchema.optional(),
          })
          .loose()
      )
      .default([]),
  })
  .loose();

/**
 * The `fields` we ask Jira for. An explicit list (rather than `*navigable`)
 * keeps responses small and, more importantly, stable — a new custom field on
 * the remote project can't silently inflate every sync page.
 */
export const ISSUE_FIELDS = [
  "summary",
  "description",
  "updated",
  "created",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "labels",
  "parent",
  "fixVersions",
] as const;
