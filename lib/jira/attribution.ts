/**
 * The Jira connection authenticates as a single account, so Jira shows every
 * comment Menara pushes as written by that account. The real author goes in a
 * fixed first paragraph instead, and the pull side strips it again so the
 * Menara copy keeps its original body.
 *
 * The wording is fixed (not localized) because the pull side recognizes it by
 * shape. Older releases wrote "via <Name> Panel"; comments they pushed are
 * still recognized.
 */
const ATTRIBUTION_PATTERN =
  /^\*Written by .+ via (?:Menara|[A-Z][A-Za-z]* Panel)\*\n\n/;

export function addAttribution(body: string, authorName: string): string {
  return `*Written by ${authorName} via Menara*\n\n${body}`;
}

export function stripAttribution(body: string): string {
  return body.replace(ATTRIBUTION_PATTERN, "");
}
