import type { z } from "zod";
import {
  ISSUE_FIELDS,
  type JiraAttachmentMeta,
  type JiraComment,
  type JiraCreateMetaField,
  type JiraIssue,
  jiraCommentPageSchema,
  jiraCommentSchema,
  jiraCreatedIssueSchema,
  jiraCreateMetaFieldsSchema,
  jiraCreateMetaIssueTypesSchema,
  jiraIssueAttachmentsSchema,
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

/** A download larger than the caller's cap; nothing past the cap is buffered. */
export class AttachmentTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Attachment exceeds ${maxBytes} bytes`);
    this.name = "AttachmentTooLargeError";
  }
}

/** Default and hard ceiling for `downloadAttachment`. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

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

/** Buffer a response body, aborting as soon as it passes `maxBytes`. */
async function readCapped(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AttachmentTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * When a failed call is sent again. `transient`: on 429, 5xx, network errors
 * and timeouts, for reads and idempotent writes. `rate-limit`: on 429 only
 * (Jira processed nothing), for writes a repeat would duplicate, such as
 * creating an issue: a 5xx or a timeout may come after Jira committed it.
 */
export type RetryPolicy = "transient" | "rate-limit";

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
   * One authenticated call, retried per `retry` (default `transient`: 429,
   * 5xx, network errors and timeouts). The response is parsed with `schema`
   * so malformed payloads fail here rather than three layers deep in the
   * mapper.
   */
  private async request<S extends z.ZodType>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT";
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      schema: S;
      retry?: RetryPolicy;
    }
  ): Promise<z.infer<S>> {
    const policy = options.retry ?? "transient";
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
        // The request may have reached Jira: only a policy that allows a
        // repeat retries it.
        if (policy !== "transient" || attempt === MAX_ATTEMPTS) throw lastError;
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
      const retryable =
        response.status === 429 ||
        (policy === "transient" && response.status >= 500);
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

  /** The issue's attachment list (metadata only), from its `attachment` field. */
  async getAttachments(idOrKey: string): Promise<JiraAttachmentMeta[]> {
    const result = await this.request(`/issue/${encodeURIComponent(idOrKey)}`, {
      query: { fields: "attachment" },
      schema: jiraIssueAttachmentsSchema,
    });
    return (result.fields.attachment ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType ?? "application/octet-stream",
      sizeBytes: a.size ?? 0,
      created: a.created ?? null,
    }));
  }

  /**
   * Download one attachment's bytes, at most `maxBytes` (default and ceiling
   * 20 MiB). Cloud answers `/attachment/content/{id}` with a redirect to the
   * media host; redirects are followed by hand so the Authorization header is
   * only ever sent to the Jira site's own origin, never to another host.
   */
  async downloadAttachment(
    id: string,
    options: { maxBytes?: number } = {}
  ): Promise<{ mime: string; bytes: Uint8Array }> {
    const maxBytes = Math.min(
      options.maxBytes ?? MAX_ATTACHMENT_BYTES,
      MAX_ATTACHMENT_BYTES
    );
    const siteOrigin = new URL(this.baseUrl).origin;
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    let url = new URL(
      `${this.baseUrl}${this.apiBase}/attachment/content/${encodeURIComponent(id)}`
    );

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const sameOrigin = url.origin === siteOrigin;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "*/*",
          ...(sameOrigin ? { Authorization: this.authHeader } : {}),
        },
        redirect: "manual",
        signal,
        cache: "no-store",
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("Location");
        await response.body?.cancel();
        if (!location) {
          throw new JiraError(response.status, "", "Redirect without Location");
        }
        const next = new URL(location, url);
        if (next.protocol !== "https:" && next.protocol !== url.protocol) {
          throw new JiraError(
            response.status,
            "",
            "Refusing insecure redirect"
          );
        }
        url = next;
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new JiraError(response.status, body);
      }

      const declared = Number(response.headers.get("Content-Length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel();
        throw new AttachmentTooLargeError(maxBytes);
      }
      const bytes = await readCapped(response, maxBytes);
      const mime =
        response.headers.get("Content-Type")?.split(";")[0]?.trim() ||
        "application/octet-stream";
      return { mime, bytes };
    }
    throw new JiraError(0, "", "Too many redirects");
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

  /**
   * Create an issue; `fields` are already in the flavor's shapes. Retried on
   * 429 only: any other failure may follow a committed create, and a repeat
   * would make a second issue.
   */
  async createIssue(
    fields: Record<string, unknown>
  ): Promise<{ id: string; key: string }> {
    const created = await this.request("/issue", {
      method: "POST",
      body: { fields },
      schema: jiraCreatedIssueSchema,
      retry: "rate-limit",
    });
    return { id: created.id, key: created.key };
  }

  /**
   * What creating an issue in `projectKey` takes: the issue type named
   * `issueTypeName` (case-insensitive), else "Task", else the first
   * non-subtask type, with the fields that type offers on the create screen.
   * Null when the project offers no issue type at all.
   */
  async getCreateMeta(
    projectKey: string,
    issueTypeName: string
  ): Promise<{
    issueType: { id: string; name: string };
    fields: JiraCreateMetaField[];
  } | null> {
    const base = `/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`;
    const page = await this.request(base, {
      query: { maxResults: 200 },
      schema: jiraCreateMetaIssueTypesSchema,
    });
    const types = (page.issueTypes ?? page.values ?? []).filter(
      (t) => t.subtask !== true
    );
    const named = (name: string) =>
      types.find((t) => t.name.toLowerCase() === name.toLowerCase());
    const issueType = named(issueTypeName) ?? named("Task") ?? types[0];
    if (!issueType) return null;
    const fieldPage = await this.request(
      `${base}/${encodeURIComponent(issueType.id)}`,
      { query: { maxResults: 200 }, schema: jiraCreateMetaFieldsSchema }
    );
    return {
      issueType: { id: issueType.id, name: issueType.name },
      fields: fieldPage.fields ?? fieldPage.results ?? fieldPage.values ?? [],
    };
  }
}
