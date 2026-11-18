import { db } from "@/lib/db";
import type { Issue } from "@/lib/db/schema";
import {
  AttachmentTooLargeError,
  JiraClient,
  JiraError,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/jira/client";
import { type ResolvedLink, resolveLink } from "@/lib/jira/sync";
import type { JiraAttachmentMeta } from "@/lib/jira/types";
import {
  HL_START,
  HL_STOP,
  type KnowledgeViewer,
  loadDocumentBySlug,
  searchDocuments,
} from "@/lib/knowledge";
import { type AttachmentRef, JIRA_KEY_PATTERN } from "../attachment-refs";
import {
  attachmentFormat,
  type ImageMediaType,
  isPdf,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  sniffImage,
  xlsxToText,
} from "../attachment-text";
import { containsSecret, redactSecretLines } from "../secret-filter";
import type { AssistantViewer } from "../viewer";
import type { ToolMeta, ToolResult } from "./code";

/**
 * Context tools: Panel-mirrored Jira issues, their live attachments, and the
 * knowledge base. Every lookup is scoped to the asking user's visibility
 * (AssistantViewer); an issue the user cannot see is "not found" and causes
 * no Jira call.
 */

export const MAX_DESCRIPTION_BYTES = 32 * 1024;
export const MAX_COMMENT_BYTES = 8 * 1024;
export const MAX_COMMENTS = 100;
export const MAX_KNOWLEDGE_BYTES = 64 * 1024;

function fail(error: string, meta: ToolMeta = {}): ToolResult<never> {
  return { ok: false, error, meta };
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes, on a character boundary. */
export function capBytes(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  // TextDecoder drops a split trailing sequence instead of emitting U+FFFD.
  const cut = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, maxBytes))
    .replace(/�$/, "");
  return { text: cut, truncated: true };
}

export function normalizeJiraKey(raw: string): string | null {
  const key = raw.trim().toUpperCase();
  return JIRA_KEY_PATTERN.test(key) ? key : null;
}

export type VisibleIssue = { issue: Issue; link: ResolvedLink | null };

/**
 * The Panel issue mirrored from Jira `key`, if its project is visible to the
 * viewer, with its project's Jira link (null when unlinked). Only issues the
 * Panel stores are reachable: the service account sees the whole Jira site,
 * so a key the Panel does not mirror for a visible project is never fetched.
 */
export async function visibleIssueByKey(
  viewer: AssistantViewer,
  rawKey: string
): Promise<VisibleIssue | null> {
  const key = normalizeJiraKey(rawKey);
  if (!key) return null;
  if (viewer.projectIds !== "all" && viewer.projectIds.length === 0) {
    return null;
  }
  const issue = await db.query.issues.findFirst({
    where:
      viewer.projectIds === "all"
        ? { jiraKey: key }
        : { jiraKey: key, projectId: { in: viewer.projectIds } },
    orderBy: { jiraSyncedAt: "desc" },
  });
  if (!issue) return null;
  const link = await resolveLink(issue.projectId);
  return { issue, link };
}

/** A client for the issue's link, or why there is none. */
function jiraClientFor(visible: VisibleIssue): JiraClient | string {
  if (!visible.link) return "this issue's project has no Jira link";
  if (!visible.link.link.enabled)
    return "Jira sync is disabled for this project";
  return new JiraClient(visible.link.credentials);
}

function jiraFailure(error: unknown): string {
  if (error instanceof AttachmentTooLargeError) {
    return "attachment is too large to read";
  }
  if (error instanceof JiraError) {
    return error.status > 0
      ? `Jira request failed (HTTP ${error.status})`
      : "Jira request failed (network error)";
  }
  throw error;
}

export type IssueAttachment = {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
};

export type IssueToolData = {
  key: string;
  title: string;
  status: string;
  type: string;
  description: string;
  descriptionTruncated: boolean;
  comments: { author: string; body: string; createdAt: string }[];
  /** Empty when the list could not be fetched; see attachmentsError. */
  attachments: IssueAttachment[];
  attachmentsError: string | null;
};

function toAttachment(meta: JiraAttachmentMeta): IssueAttachment {
  return {
    id: meta.id,
    filename: meta.filename,
    mime: meta.mimeType,
    sizeBytes: meta.sizeBytes,
  };
}

/**
 * The live attachment list of a visible issue (from visibleIssueByKey), or
 * why it could not be fetched (English, for the model). Shared by get_issue
 * and the API's attachment tick list, so both list the same files.
 */
export async function listIssueAttachments(
  visible: VisibleIssue
): Promise<{ attachments: IssueAttachment[]; error: string | null }> {
  const client = jiraClientFor(visible);
  if (typeof client === "string") return { attachments: [], error: client };
  const { issue } = visible;
  try {
    const list = await client.getAttachments(
      issue.jiraIssueId ?? issue.jiraKey ?? ""
    );
    return { attachments: list.map(toAttachment), error: null };
  } catch (error) {
    return { attachments: [], error: jiraFailure(error) };
  }
}

export async function getIssueTool(
  viewer: AssistantViewer,
  rawKey: string
): Promise<ToolResult<IssueToolData>> {
  const visible = await visibleIssueByKey(viewer, rawKey);
  if (!visible) return fail(`issue ${rawKey.trim()} not found`);
  const { issue } = visible;
  const key = issue.jiraKey ?? rawKey.trim().toUpperCase();

  const latest = await db.query.issueComments.findMany({
    where: { issueId: issue.id },
    with: { author: { columns: { name: true } } },
    orderBy: { createdAt: "desc" },
    limit: MAX_COMMENTS,
  });
  let withheld = 0;
  const redact = (text: string): string => {
    const result = redactSecretLines(text);
    withheld += result.redacted;
    return result.text;
  };
  const comments = latest.reverse().map((c) => {
    const body = capBytes(redact(c.body), MAX_COMMENT_BYTES);
    return {
      author: c.author?.name ?? "Unknown",
      body: body.truncated ? `${body.text}\n[truncated]` : body.text,
      createdAt: c.createdAt.toISOString(),
    };
  });

  const { attachments, error: attachmentsError } =
    await listIssueAttachments(visible);

  const description = capBytes(
    redact(issue.description),
    MAX_DESCRIPTION_BYTES
  );
  return {
    ok: true,
    data: {
      key,
      title: redact(issue.title),
      status: issue.status,
      type: issue.type,
      description: description.text,
      descriptionTruncated: description.truncated,
      comments,
      attachments,
      attachmentsError,
    },
    // Redacted credential lines, as for files withheld by the code tools.
    meta: withheld > 0 ? { issueKeys: [key], withheld } : { issueKeys: [key] },
  };
}

export type AttachmentContent =
  | { kind: "document"; mediaType: "application/pdf"; base64: string }
  | { kind: "image"; mediaType: ImageMediaType; base64: string }
  | { kind: "text"; text: string };

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64"
  );
}

/**
 * Read one attachment the user ticked on this message. The (issue key,
 * attachment id) pair must be one of the ticked pairs, and the tick list
 * alone is not trusted: the attachment must also be on an issue the viewer
 * can see.
 */
export async function readAttachmentTool(
  viewer: AssistantViewer,
  tickedAttachments: readonly AttachmentRef[],
  input: { issueKey: string; attachmentId: string }
): Promise<ToolResult<AttachmentContent>> {
  const attachmentId = input.attachmentId.trim();
  const issueKey = normalizeJiraKey(input.issueKey);
  const ticked = tickedAttachments.some(
    (a) => a.issueKey === issueKey && a.attachmentId === attachmentId
  );
  if (!ticked) {
    return fail(
      `attachment ${attachmentId} on ${input.issueKey.trim()} was not selected by the user for this message; ask them to tick it`
    );
  }
  const visible = await visibleIssueByKey(viewer, input.issueKey);
  if (!visible) return fail(`issue ${input.issueKey.trim()} not found`);
  const key = visible.issue.jiraKey ?? input.issueKey.trim().toUpperCase();
  const meta: ToolMeta = { issueKeys: [key] };

  const client = jiraClientFor(visible);
  if (typeof client === "string") return fail(client, meta);

  let found: JiraAttachmentMeta | undefined;
  try {
    const list = await client.getAttachments(visible.issue.jiraIssueId ?? key);
    found = list.find((a) => a.id === attachmentId);
  } catch (error) {
    return fail(jiraFailure(error), meta);
  }
  if (!found)
    return fail(`attachment ${attachmentId} not found on ${key}`, meta);

  const format = attachmentFormat(found);
  if (format === "unsupported") {
    return fail(
      `format not supported in v1 (${found.filename}); PDF, PNG, JPEG, GIF, WebP and XLSX can be read`,
      meta
    );
  }
  const limit =
    format === "image"
      ? MAX_IMAGE_BYTES
      : format === "pdf"
        ? MAX_PDF_BYTES
        : MAX_ATTACHMENT_BYTES;
  if (found.sizeBytes > limit)
    return fail("attachment is too large to read", meta);

  let bytes: Uint8Array;
  try {
    ({ bytes } = await client.downloadAttachment(attachmentId, {
      maxBytes: limit,
    }));
  } catch (error) {
    return fail(jiraFailure(error), meta);
  }
  const readMeta: ToolMeta = { ...meta, attachmentIds: [attachmentId] };

  if (format === "pdf") {
    if (!isPdf(bytes)) return fail("attachment is not a valid PDF", meta);
    return {
      ok: true,
      data: {
        kind: "document",
        mediaType: "application/pdf",
        base64: base64(bytes),
      },
      meta: readMeta,
    };
  }
  if (format === "image") {
    const mediaType = sniffImage(bytes);
    if (!mediaType) return fail("attachment is not a readable image", meta);
    return {
      ok: true,
      data: { kind: "image", mediaType, base64: base64(bytes) },
      meta: readMeta,
    };
  }

  let text: string;
  try {
    ({ text } = await xlsxToText(bytes));
  } catch {
    return fail("attachment is not a readable XLSX workbook", meta);
  }
  if (containsSecret(text, "config")) {
    return fail("attachment withheld: contains credentials", meta);
  }
  return {
    ok: true,
    data: { kind: "text", text: `# ${found.filename}\n\n${text}` },
    meta: readMeta,
  };
}

// The knowledge rules (collection visibility by org role, drafts) for the
// asking user, built from their AccessScope since the worker has no session.
function knowledgeViewer(viewer: AssistantViewer): KnowledgeViewer {
  return {
    userId: viewer.userId,
    role: viewer.orgRole,
    canManage: viewer.canManageKnowledge,
  };
}

export type KnowledgeHit = { slug: string; title: string; snippet: string };

export async function searchKnowledgeTool(
  viewer: AssistantViewer,
  query: string
): Promise<ToolResult<{ hits: KnowledgeHit[] }>> {
  if (!query.trim()) return fail("query must not be empty");
  const hits = await searchDocuments(query, knowledgeViewer(viewer));
  let withheld = 0;
  const data = {
    hits: hits.map((h) => {
      const snippet = redactSecretLines(
        h.snippet.replaceAll(HL_START, "").replaceAll(HL_STOP, "")
      );
      withheld += snippet.redacted;
      return { slug: h.slug, title: h.title, snippet: snippet.text };
    }),
  };
  const docSlugs = hits.map((h) => h.slug);
  return {
    ok: true,
    data,
    meta: withheld > 0 ? { docSlugs, withheld } : { docSlugs },
  };
}

export async function readKnowledgeTool(
  viewer: AssistantViewer,
  slug: string
): Promise<
  ToolResult<{
    slug: string;
    title: string;
    collection: string | null;
    markdown: string;
    truncated: boolean;
  }>
> {
  const doc = await loadDocumentBySlug(slug.trim(), knowledgeViewer(viewer));
  if (!doc) return fail(`knowledge document ${slug.trim()} not found`);
  const redacted = redactSecretLines(doc.content);
  const body = capBytes(redacted.text, MAX_KNOWLEDGE_BYTES);
  return {
    ok: true,
    data: {
      slug: doc.slug,
      title: doc.title,
      collection: doc.collection?.name ?? null,
      markdown: body.text,
      truncated: body.truncated,
    },
    meta:
      redacted.redacted > 0
        ? { docSlugs: [doc.slug], withheld: redacted.redacted }
        : { docSlugs: [doc.slug] },
  };
}
