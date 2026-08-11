/**
 * The URL contract of the global issues list.
 *
 * Filters, sort and page live in the query string, not in component state: the
 * list is rendered from the database on the server, so the URL is the single
 * source of truth that the page, the client toolbar and a saved view all agree
 * on — and a link to a filtered list is shareable and reload-proof.
 *
 * Plain module (no "use server"): a Server Actions file may only export async
 * functions, so the shared constants live here.
 */

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
