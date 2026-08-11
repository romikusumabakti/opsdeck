import type {
  IssuePriority,
  IssueStatus,
  IssueType,
  JiraMappingOverrides,
} from "@/lib/db/schema";

/**
 * Field mapping between Jira's vocabulary and OpsDeck's four-value enums.
 *
 * Pure functions over plain strings — no database, no client — so the whole
 * mapping is unit-testable (tests/jira-mapping.test.ts) and callable from both
 * the sync and push directions.
 *
 * The inbound default keys off Jira's **status category**, not the status
 * name. Categories (`new` / `indeterminate` / `done`) are a fixed, three-value
 * system field; status names are per-workflow and get renamed at will. Keying
 * off the category means a team can rename "In Progress" to "Sedang dikerjakan"
 * without breaking sync. A per-link override keys off the *name*, because the
 * only reason to override is a workflow whose names carry distinctions the
 * three categories flatten — "Ready for QA" and "In Progress" are both
 * `indeterminate`, but a team may want the former to land on `resolved`.
 */

export type RemoteStatus = {
  name: string;
  categoryKey?: string;
};

const STATUS_BY_CATEGORY: Record<string, IssueStatus> = {
  new: "open",
  // Jira's own alias for the "new" category on some endpoints.
  undefined: "open",
  indeterminate: "in_progress",
  done: "closed",
};

const TYPE_BY_NAME: Record<string, IssueType> = {
  bug: "bug",
  defect: "bug",
  task: "task",
  "sub-task": "task",
  subtask: "task",
  story: "story",
  "user story": "story",
  epic: "epic",
  improvement: "task",
  "new feature": "story",
};

const PRIORITY_BY_NAME: Record<string, IssuePriority> = {
  highest: "urgent",
  blocker: "urgent",
  critical: "urgent",
  urgent: "urgent",
  high: "high",
  major: "high",
  medium: "medium",
  normal: "medium",
  low: "low",
  minor: "low",
  lowest: "low",
  trivial: "low",
};

/** Case- and whitespace-insensitive key for every override/default lookup. */
function key(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Remote status → OpsDeck status. A name override wins over the category
 * default; an unrecognized category falls back to `open` (visible and
 * actionable) rather than `closed` (silently hidden from the board).
 */
export function mapStatus(
  remote: RemoteStatus | null | undefined,
  overrides?: JiraMappingOverrides | null
): IssueStatus {
  const override = overrides?.status?.[key(remote?.name)];
  if (override) return override;
  return STATUS_BY_CATEGORY[key(remote?.categoryKey)] ?? "open";
}

/** Remote issue type → OpsDeck type. Unknown types are ordinary work. */
export function mapType(
  name: string | null | undefined,
  overrides?: JiraMappingOverrides | null
): IssueType {
  return overrides?.type?.[key(name)] ?? TYPE_BY_NAME[key(name)] ?? "task";
}

/** Remote priority → OpsDeck priority. Unset priority means `medium`. */
export function mapPriority(
  name: string | null | undefined,
  overrides?: JiraMappingOverrides | null
): IssuePriority {
  return (
    overrides?.priority?.[key(name)] ?? PRIORITY_BY_NAME[key(name)] ?? "medium"
  );
}

/**
 * OpsDeck status → the Jira status category a transition must land in.
 *
 * The ambiguous direction is pinned here: `resolved` and `closed` both map to
 * `done`, because Jira has no "resolved but not closed" category. Push looks
 * up the available transitions and picks one whose target sits in this
 * category — it never matches on a status name, for the same reason inbound
 * doesn't.
 */
export function targetCategoryFor(status: IssueStatus): string {
  switch (status) {
    case "open":
      return "new";
    case "in_progress":
      return "indeterminate";
    default:
      return "done";
  }
}

/**
 * Names Jira commonly uses for each OpsDeck priority, best first. Push tries
 * them in order against the values the remote project actually offers, since
 * `priority` is a select whose allowed values vary per project.
 */
const PRIORITY_NAME_CANDIDATES: Record<IssuePriority, string[]> = {
  urgent: ["Highest", "Blocker", "Critical", "Urgent"],
  high: ["High", "Major"],
  medium: ["Medium", "Normal"],
  low: ["Low", "Minor", "Lowest"],
};

export function priorityNameCandidates(priority: IssuePriority): string[] {
  return PRIORITY_NAME_CANDIDATES[priority];
}

/**
 * Merge a user-supplied override object into a normalized, lowercased shape,
 * dropping anything that isn't a valid target enum value. Overrides arrive as
 * free-form JSON (from the settings form and, historically, from whatever was
 * already in the column), so this is the boundary that keeps an invalid value
 * out of the mapper.
 */
export function normalizeOverrides(
  raw: unknown,
  valid: {
    status: readonly string[];
    type: readonly string[];
    priority: readonly string[];
  }
): JiraMappingOverrides | null {
  if (raw == null || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const pick = <T extends string>(
    field: "status" | "type" | "priority",
    allowed: readonly string[]
  ): Record<string, T> | undefined => {
    const entry = source[field];
    if (entry == null || typeof entry !== "object") return undefined;
    const out: Record<string, T> = {};
    for (const [name, value] of Object.entries(entry)) {
      if (typeof value === "string" && allowed.includes(value)) {
        out[key(name)] = value as T;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const result: JiraMappingOverrides = {
    status: pick<IssueStatus>("status", valid.status),
    type: pick<IssueType>("type", valid.type),
    priority: pick<IssuePriority>("priority", valid.priority),
  };
  return result.status || result.type || result.priority ? result : null;
}
