import "server-only";

import type { z } from "zod";
import {
  ISSUE_FIELDS,
  type JiraComment,
  type JiraIssue,
  jiraCommentPageSchema,
  jiraCommentSchema,
  jiraIssueSchema,
  jiraMyselfSchema,
  jiraProjectSchema,
  jiraSearchPageSchema,
  jiraTransitionsSchema,
} from "./types";

/**
 * Minimal Jira REST client.
 *
 * Covers both deployments behind one interface: Cloud speaks API v3 (ADF rich
 * text, token-cursor search) and Data Center speaks v2 (wiki markup, offset
 * search). The differences are confined to `apiBase`, the auth header, and
 * `searchIssues` — everything above this file is deployment-agnostic.
 *
 * Credentials arrive already decrypted. Nothing here reads the database or
 * `process.env`: the caller (a server action or a job handler) loads the
 * connection row and decrypts the token, so a token never lands in a queue
 * payload.
 */

export type JiraCredentials = {
  baseUrl: string;
  flavor: "cloud" | "datacenter";
  /** Cloud only — the Basic-auth username paired with the API token. */
  email: string | null;
  /** Decrypted API token (Cloud) or personal access token (Data Center). */
  token: string;
};

/** A failed Jira call, carrying the HTTP status so callers can branch on it. */
export class JiraError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `Jira request failed (${status}): ${truncate(body, 300)}`);
    this.name = "JiraError";
    this.status = status;
    this.body = body;
  }

  /** 401/403 — bad credentials or missing scope. Retrying will not help. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Strip a trailing slash so path joins never produce `//`. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
// Jira caps page size at 100 for both search and comments.
const PAGE_SIZE = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before retry `attempt` (1-based). Honors Jira's
 * `Retry-After` (seconds) when present — it is authoritative during a 429 —
 * and otherwise backs off exponentially with jitter so several concurrent
 * syncs against one site don't re-collide in lockstep.
 */
function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 60_000);
  }
  return 2 ** attempt * 500 + Math.floor(Math.random() * 250);
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly flavor: "cloud" | "datacenter";
  private readonly authHeader: string;

  constructor(credentials: JiraCredentials) {
    this.baseUrl = normalizeBaseUrl(credentials.baseUrl);
    this.flavor = credentials.flavor;
    this.authHeader =
      credentials.flavor === "cloud"
        ? `Basic ${Buffer.from(
            `${credentials.email ?? ""}:${credentials.token}`
          ).toString("base64")}`
        : `Bearer ${credentials.token}`;
  }

  /** `/rest/api/3` on Cloud, `/rest/api/2` on Data Center. */
  private get apiBase(): string {
    return this.flavor === "cloud" ? "/rest/api/3" : "/rest/api/2";
  }

  /**
   * One authenticated call, retried on 429 and 5xx. The response is parsed
   * with `schema` so malformed payloads fail here rather than three layers
   * deep in the mapper.
   */
  private async request<S extends z.ZodType>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT";
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      schema: S;
    }
  ): Promise<z.infer<S>> {
    const url = new URL(`${this.baseUrl}${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let lastError: JiraError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: options.method ?? "GET",
          headers: {
            Authorization: this.authHeader,
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          cache: "no-store",
        });
      } catch (error) {
        // Network error / timeout. Treated like a 5xx: worth one more try.
        lastError = new JiraError(
          0,
          error instanceof Error ? error.message : String(error),
          `Jira request failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        if (attempt === MAX_ATTEMPTS) throw lastError;
        await sleep(retryDelayMs(attempt, null));
        continue;
      }

      if (response.ok) {
        // 204 on transitions/assignee — no body to parse.
        if (response.status === 204) return options.schema.parse({});
        const text = await response.text();
        return options.schema.parse(text.length > 0 ? JSON.parse(text) : {});
      }

      const body = await response.text().catch(() => "");
      lastError = new JiraError(response.status, body);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(retryDelayMs(attempt, response.headers.get("Retry-After")));
    }
    // Unreachable: the loop either returns or throws.
    throw lastError ?? new JiraError(0, "", "Jira request failed");
  }

  /** Credential probe — also the source of "Connected as …" in the UI. */
  async getMyself() {
    return this.request("/myself", { schema: jiraMyselfSchema });
  }

  /** Verify a project key exists and is visible to these credentials. */
  async getProject(key: string) {
    return this.request(`/project/${encodeURIComponent(key)}`, {
      schema: jiraProjectSchema,
    });
  }

  async getIssue(idOrKey: string): Promise<JiraIssue> {
    return this.request(`/issue/${encodeURIComponent(idOrKey)}`, {
      query: { fields: ISSUE_FIELDS.join(",") },
      schema: jiraIssueSchema,
    });
  }

  /**
   * Page through a JQL query, yielding one page at a time so the caller can
   * apply and commit incrementally instead of buffering a whole project.
   *
   * Cloud uses the token-cursor `/search/jql` endpoint (the offset-based
   * `/search` was retired); Data Center still uses offset paging. Both are
   * driven by the same `ORDER BY updated ASC` contract from lib/jira/sync.ts,
   * which is what makes a partial sweep resumable.
   */
  async *searchIssues(jql: string): AsyncGenerator<JiraIssue[]> {
    if (this.flavor === "cloud") {
      let nextPageToken: string | undefined;
      do {
        const page = await this.request("/search/jql", {
          method: "POST",
          body: {
            jql,
            fields: [...ISSUE_FIELDS],
            maxResults: PAGE_SIZE,
            nextPageToken,
          },
          schema: jiraSearchPageSchema,
        });
        if (page.issues.length > 0) yield page.issues;
        nextPageToken = page.nextPageToken ?? undefined;
        // `isLast` is authoritative when present; otherwise an absent cursor
        // ends the walk.
        if (page.isLast === true) nextPageToken = undefined;
      } while (nextPageToken);
      return;
    }

    let startAt = 0;
    for (;;) {
      const page = await this.request("/search", {
        method: "POST",
        body: {
          jql,
          fields: [...ISSUE_FIELDS],
          maxResults: PAGE_SIZE,
          startAt,
        },
        schema: jiraSearchPageSchema,
      });
      if (page.issues.length === 0) return;
      yield page.issues;
      startAt += page.issues.length;
      if (page.total != null && startAt >= page.total) return;
    }
  }

  /**
   * Comments on an issue, oldest-first. Capped at one page: a thread longer
   * than 100 comments is mirrored up to its most recent 100, which is what the
   * detail view shows anyway. `orderBy=-created` + reverse keeps the *latest*
   * ones rather than the oldest.
   *
   * `complete` says whether that cap was hit. The caller needs it: pruning
   * local mirrors whose remote counterpart is gone is only sound when we have
   * seen the entire thread, otherwise a truncated page would delete every
   * comment older than the window on every sweep.
   */
  async getComments(
    issueId: string
  ): Promise<{ comments: JiraComment[]; complete: boolean }> {
    const page = await this.request(
      `/issue/${encodeURIComponent(issueId)}/comment`,
      {
        query: { maxResults: PAGE_SIZE, orderBy: "-created" },
        schema: jiraCommentPageSchema,
      }
    );
    return {
      comments: [...page.comments].reverse(),
      complete: page.comments.length < PAGE_SIZE,
    };
  }

  // --- Write side (only reached when a link has pushEnabled) ---

  async updateIssueFields(
    idOrKey: string,
    fields: Record<string, unknown>
  ): Promise<void> {
    await this.request(`/issue/${encodeURIComponent(idOrKey)}`, {
      method: "PUT",
      body: { fields },
      schema: jiraIssueSchema.partial().loose(),
    });
  }

  async getTransitions(idOrKey: string) {
    const result = await this.request(
      `/issue/${encodeURIComponent(idOrKey)}/transitions`,
      { schema: jiraTransitionsSchema }
    );
    return result.transitions;
  }

  async transitionIssue(idOrKey: string, transitionId: string): Promise<void> {
    await this.request(`/issue/${encodeURIComponent(idOrKey)}/transitions`, {
      method: "POST",
      body: { transition: { id: transitionId } },
      schema: jiraTransitionsSchema.partial().loose(),
    });
  }

  /**
   * Reassign. `accountId` is Cloud's identifier and `name` is Data Center's;
   * passing `null` unassigns on both.
   */
  async assignIssue(idOrKey: string, account: string | null): Promise<void> {
    const body =
      this.flavor === "cloud" ? { accountId: account } : { name: account };
    await this.request(`/issue/${encodeURIComponent(idOrKey)}/assignee`, {
      method: "PUT",
      body,
      schema: jiraIssueSchema.partial().loose(),
    });
  }

  /** Post a comment. `body` is already in the flavor's rich-text shape. */
  async addComment(idOrKey: string, body: unknown): Promise<JiraComment> {
    return this.request(`/issue/${encodeURIComponent(idOrKey)}/comment`, {
      method: "POST",
      body: { body },
      schema: jiraCommentSchema,
    });
  }
}
