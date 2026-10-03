// Pure grouping for Home's "Needs attention". Client-safe: no DB, no
// server-only imports, so the list component can reuse failurePrefill.

export const ATTENTION_WINDOW_DAYS = 7;
export const ATTENTION_LIMIT = 8;
export const ERROR_EXCERPT_MAX = 2000;
// issueInputSchema caps titles at 300.
const TITLE_MAX = 300;

// What makes two failures "the same problem". Legacy runs predate `kind`, so
// they fall back to their description. lib/home/queries.ts mirrors this in SQL
// as coalesce(kind::text, description).
export function attentionKey(run: {
  kind: string | null;
  description: string;
}): string {
  return run.kind ?? run.description;
}

export type FailureRow = {
  id: string;
  environmentId: string;
  kind: string | null;
  description: string;
  errorMessage: string | null;
  runAt: Date;
  environmentName: string;
  envPath: string;
  projectId: string;
};

export type SuccessRow = { environmentId: string; key: string; runAt: Date };

export type FailureGroup = {
  key: string;
  environmentId: string;
  environmentName: string;
  envPath: string;
  projectId: string;
  count: number;
  latest: {
    id: string;
    kind: string | null;
    description: string;
    errorMessage: string | null;
    runAt: Date;
  };
};

const groupId = (environmentId: string, key: string) =>
  `${environmentId}\u0000${key}`;

/**
 * Collapse unacknowledged failures into one group per (environment, key).
 * Drops a group when a success with the same key in the same environment is
 * newer than the group's latest failure (it has been fixed since). Newest
 * group first, capped at `limit`.
 */
export function groupFailures(
  failures: FailureRow[],
  successes: SuccessRow[],
  limit = ATTENTION_LIMIT
): FailureGroup[] {
  const lastSuccess = new Map<string, number>();
  for (const s of successes) {
    const id = groupId(s.environmentId, s.key);
    lastSuccess.set(
      id,
      Math.max(lastSuccess.get(id) ?? -Infinity, s.runAt.getTime())
    );
  }

  const groups = new Map<string, FailureGroup>();
  for (const f of failures) {
    const key = attentionKey(f);
    const id = groupId(f.environmentId, key);
    const latest = {
      id: f.id,
      kind: f.kind,
      description: f.description,
      errorMessage: f.errorMessage,
      runAt: f.runAt,
    };
    const existing = groups.get(id);
    if (!existing) {
      groups.set(id, {
        key,
        environmentId: f.environmentId,
        environmentName: f.environmentName,
        envPath: f.envPath,
        projectId: f.projectId,
        count: 1,
        latest,
      });
      continue;
    }
    existing.count += 1;
    if (f.runAt > existing.latest.runAt) existing.latest = latest;
  }

  return [...groups.entries()]
    .filter(
      ([id, g]) =>
        (lastSuccess.get(id) ?? -Infinity) <= g.latest.runAt.getTime()
    )
    .map(([, g]) => g)
    .sort((a, b) => b.latest.runAt.getTime() - a.latest.runAt.getTime())
    .slice(0, limit);
}

// A fence longer than any backtick run inside the text, so an error that
// contains ``` can't close the block early.
function fenceFor(text: string): string {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length)
  );
  return "`".repeat(Math.max(3, longest + 1));
}

/** Prefill for "create an issue from this failure". */
export function failurePrefill(
  group: {
    latest: { description: string; errorMessage: string | null };
    envPath: string;
  },
  title: string,
  linkLabel: string
): { type: "bug"; title: string; description: string } {
  const parts = [group.latest.description];
  const error = group.latest.errorMessage?.trim();
  if (error) {
    const excerpt =
      error.length > ERROR_EXCERPT_MAX
        ? `${error.slice(0, ERROR_EXCERPT_MAX)}…`
        : error;
    const fence = fenceFor(excerpt);
    parts.push(`${fence}\n${excerpt}\n${fence}`);
  }
  parts.push(`[${linkLabel}](${group.envPath}/history)`);
  return {
    type: "bug",
    title: title.slice(0, TITLE_MAX),
    description: parts.join("\n\n"),
  };
}
