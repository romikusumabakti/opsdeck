/**
 * The URL contract of the global issues list.
 *
 * Filters, sort and page live in the query string, not in component state: the
 * list is rendered from the database on the server, so the URL is the single
 * source of truth that the page, the client toolbar and a saved view all agree
 * on — and a link to a filtered list is shareable and reload-proof.
 *
 * Plain module shared by the client and server, so the constants live here.
 */

import type { z } from "zod";
import type { issueStatusSchema } from "@/lib/validation";

type Status = z.infer<typeof issueStatusSchema>;

const STATUSES = ["open", "in_progress", "resolved", "closed"] as const;

/** Statuses that count as "still needs work": the list default and the badges. */
export const OPEN_STATUSES = ["open", "in_progress"] as const;

/** URL value of the status filter that lifts the default and shows everything. */
export const STATUS_ALL = "all";

export type IssueView = "table" | "board";

/**
 * Which statuses the list shows for the raw `status` URL param.
 *
 * Unset means "active" on the table, because a backlog full of closed issues
 * buries the work; the board keeps every status since its columns are the
 * statuses. `all` lifts the default. A junk value falls back to the default
 * rather than an empty list. `null` means no status condition.
 */
export function resolveStatusFilter(
  raw: string | undefined,
  view: IssueView
): readonly Status[] | null {
  if (raw === STATUS_ALL) return null;
  if (raw && (STATUSES as readonly string[]).includes(raw)) {
    return [raw as Status];
  }
  return view === "board" ? null : OPEN_STATUSES;
}

/** Sortable columns, in sync with the SQL mapping in `listAllIssues`. */
export const ISSUE_SORTS = [
  "key",
  "title",
  "project",
  "status",
  "priority",
  "assignee",
  "createdAt",
  "updatedAt",
] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

export const DEFAULT_ISSUE_SORT: IssueSort = "updatedAt";
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Prefix `DataTable` uses for its own state params (`iss_s`, `iss_d`, `iss_p`,
 * `iss_ps`). Shared so the server parses exactly what the table writes.
 */
export const TABLE_URL_KEY = "iss";

/** Params owned by the toolbar (everything that isn't sort/page). */
export const ISSUE_FILTER_KEYS = [
  "q",
  "status",
  "project",
  "label",
  "priority",
  "mine",
  "assignee",
  "view",
  "group",
] as const;

/**
 * The board renders every matching issue at once (columns have no pager), so it
 * is capped instead of paged. Above this the UI says the view is truncated
 * rather than silently lying about the backlog.
 */
export const BOARD_LIMIT = 200;

export type IssueParams = {
  /** Raw filter values, defaults omitted — also the saved-view payload. */
  filters: Record<string, string>;
  sort: IssueSort;
  desc: boolean;
  pageIndex: number;
  pageSize: number;
};

type SearchParams = Record<string, string | string[] | undefined>;

function one(sp: SearchParams, key: string): string | undefined {
  const v = sp[key];
  return typeof v === "string" && v ? v : undefined;
}

/** Read the page's URL state, ignoring anything malformed. */
export function parseIssueParams(sp: SearchParams): IssueParams {
  const filters: Record<string, string> = {};
  for (const k of ISSUE_FILTER_KEYS) {
    const v = one(sp, k);
    if (v) filters[k] = v;
  }

  const rawSort = one(sp, `${TABLE_URL_KEY}_s`);
  const sort = (ISSUE_SORTS as readonly string[]).includes(rawSort ?? "")
    ? (rawSort as IssueSort)
    : DEFAULT_ISSUE_SORT;
  // Sorting a column for the first time should show the most recent / highest
  // first, so descending is the default for every column but the explicit
  // `asc` marker.
  const desc = one(sp, `${TABLE_URL_KEY}_d`) !== "asc";

  const pageIndex = Math.max(
    0,
    Math.trunc(Number(one(sp, `${TABLE_URL_KEY}_p`) ?? 0)) || 0
  );
  const rawSize = Math.trunc(
    Number(one(sp, `${TABLE_URL_KEY}_ps`) ?? DEFAULT_PAGE_SIZE)
  );
  const pageSize =
    Number.isFinite(rawSize) && rawSize > 0
      ? Math.min(rawSize, 100)
      : DEFAULT_PAGE_SIZE;

  return { filters, sort, desc, pageIndex, pageSize };
}
