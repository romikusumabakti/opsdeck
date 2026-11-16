/**
 * A Jira attachment the user ticked for a question: the issue it belongs to
 * and its id. Stored as `KEY:id` strings in assistant_messages.attachment_ids
 * so the worker can tell the model (and read_attachment can check) which
 * issue each ticked attachment is on.
 */

export type AttachmentRef = { issueKey: string; attachmentId: string };

/** A normalized (upper-case) Jira issue key, e.g. KST-123. */
export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;
/** Jira attachment ids are numeric strings. */
export const ATTACHMENT_ID_PATTERN = /^[1-9][0-9]{0,18}$/;

export function formatAttachmentRef(ref: AttachmentRef): string {
  return `${ref.issueKey}:${ref.attachmentId}`;
}

/** Null for anything that is not a well-formed `KEY:id`. */
export function parseAttachmentRef(raw: string): AttachmentRef | null {
  const at = raw.lastIndexOf(":");
  if (at === -1) return null;
  const issueKey = raw.slice(0, at);
  const attachmentId = raw.slice(at + 1);
  if (!JIRA_KEY_PATTERN.test(issueKey)) return null;
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) return null;
  return { issueKey, attachmentId };
}

/** The well-formed refs of a stored list, in order; others are dropped. */
export function parseAttachmentRefs(raw: readonly string[]): AttachmentRef[] {
  return raw.flatMap((r) => {
    const ref = parseAttachmentRef(r);
    return ref ? [ref] : [];
  });
}
