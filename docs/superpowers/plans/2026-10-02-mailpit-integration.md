# Mailpit Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members can read, search, download from, and delete the email an environment's app sends, from a per-environment Mailpit, inside OpsDeck, with live updates.

**Architecture:** OpsDeck stores one optional Mailpit connection per environment in a new 1:1 table `environment_mailpit`. The password is encrypted with `lib/secrets.ts`. The browser never talks to Mailpit:
- Server actions (`actions/mail.ts`, `actions/mailpit-settings.ts`) call Mailpit's REST API through a thin typed client (`lib/mailpit/client.ts`).
- Three route handlers stream downloads (part, raw) and relay Mailpit's `/api/events` WebSocket as SSE.
- Email HTML is pre-processed server-side (`cid:` → `data:`, CSP prelude) and rendered in an `<iframe srcdoc sandbox>`.

**Tech Stack:** Next.js 16 (App Router, server actions, route handlers), React 19.2, Drizzle ORM (Postgres, hand-written SQL migrations), zod 4, next-intl 4, shadcn/base-ui components, Bun 1.4 runtime + `bun test`, Biome.

**Spec:** `docs/superpowers/specs/2026-10-02-mailpit-integration-design.md`

## Global Constraints

- Runtime is Bun in production (`CMD ["bun", "server.js"]`); `next dev` runs on Node 24. Code must work on both.
- Every new user-facing string goes into all five `messages/{ar,en,es,id,zh}.json`.
- Commit messages: Conventional-ish imperative subject, **no `Co-Authored-By: Claude` trailer** (repo rule).
- Mailpit URL/credentials are only ever read from the DB, never from the client. The one exception is the admin-only Test connection action, and it reuses the stored password only when the URL equals the stored URL.
- Capability `mail` = minimum role `member`; it guards read, delete, download and the event stream.
- Page size 50. Inline image caps: 2 MB per part, 10 MB total. Raw source preview cap: 1 MB. API timeout 10 s, download timeout 60 s.
- SSE stream: 10-minute cap, 15 s heartbeat, `retry: 10000`.
- Iframe: `srcdoc` + `sandbox="allow-popups allow-popups-to-escape-sandbox"` (never `allow-scripts` / `allow-same-origin`).
- Do not apply the migration to the production DB as part of this plan (prod migrations are applied manually by the user).
- Verification commands: `bun test`, `bun run typecheck`, `bun run lint`.

## Review Focus

1. **Mailpit served under a webroot** (`https://host/mailpit` with or without a trailing slash): every API, part, raw and events URL must keep the `/mailpit/` prefix. *Pinned in Task 4 (`mailpitUrl` / `mailpitEventsUrl` tests).*
2. **"Delete selected" with an empty selection must never become "delete everything"** (Mailpit treats `{"IDs":[]}` as delete all). *Pinned in Task 4 (client guard test) and Task 8 (schema rejects empty `ids`).*
3. **Hostile email HTML/attachments** (`<script>`, a `text/html` or SVG attachment, a weird `Content-Type` on an inline image): nothing executes on the OpsDeck origin. *Pinned in Task 5 (content-type sanitising + prelude tests) and Task 9 (`attachmentDisposition` + forced octet-stream in `lib/mailpit/download.ts`).*
4. **Credential exfiltration via Test connection:** an admin points the URL at their own host with a blank password field. The stored password must not be sent. *Pinned in Task 6 (`shouldReuseStoredPassword` test).*
5. **Mailpit down or credentials wrong:** inbox shows a readable reason (ECONNREFUSED / authentication failed / timeout), the SSE reconnects no faster than every 10 s, and the page does not crash. *Pinned in Task 4 (error mapping tests) and Task 10 (`retry:` frame).*

---

### Task 1: Extract `describeFetchError` into a shared module

**Files:**
- Create: `lib/fetch-error.ts`
- Modify: `actions/mock-time.ts:62-87` (remove local function, import shared one)
- Test: `tests/fetch-error.test.ts`

**Interfaces:**
- Produces: `describeFetchError(err: unknown): string` from `@/lib/fetch-error`.

- [ ] **Step 1: Write the failing test** — `tests/fetch-error.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import { describeFetchError } from "@/lib/fetch-error";

describe("describeFetchError", () => {
  it("surfaces the first AggregateError cause with its code", () => {
    const err = new TypeError("fetch failed", {
      cause: {
        errors: [
          { code: "ECONNREFUSED", message: "connect ECONNREFUSED 10.0.0.5:8025" },
        ],
      },
    });
    expect(describeFetchError(err)).toBe(
      "ECONNREFUSED: connect ECONNREFUSED 10.0.0.5:8025"
    );
  });

  it("falls back to a bare cause code", () => {
    const err = new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    expect(describeFetchError(err)).toBe("ENOTFOUND");
  });

  it("uses the error message when there is no cause", () => {
    expect(describeFetchError(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-errors", () => {
    expect(describeFetchError("nope")).toBe("nope");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/fetch-error.test.ts`
Expected: FAIL — `Cannot find module '@/lib/fetch-error'`.

- [ ] **Step 3: Create `lib/fetch-error.ts`** (body moved verbatim from `actions/mock-time.ts`)

```ts
// Node's fetch retries every resolved address (Happy Eyeballs). When all fail
// it surfaces an AggregateError under `cause` whose `errors[]` each carry the
// real reason (ETIMEDOUT, ECONNREFUSED, ENETUNREACH...). Pull the most useful
// one for the toast. Shared by every outbound HTTP integration (mock-time,
// Mailpit).
export function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const errors = (
        cause as { errors?: Array<{ code?: string; message?: string }> }
      ).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0];
        if (first) {
          return first.code
            ? `${first.code}: ${first.message ?? ""}`
            : (first.message ?? err.message);
        }
      }
      const code = (cause as { code?: string }).code;
      if (code) return code;
    }
    return err.message || err.name;
  }
  return String(err);
}
```

- [ ] **Step 4: Update `actions/mock-time.ts`**
  - Delete the comment block and the `function describeFetchError(...) { ... }` definition (currently lines 62-87).
  - Add `import { describeFetchError } from "@/lib/fetch-error";` to the import block, sorted alphabetically after `@/lib/environments`.
  - Leave every call site as it is.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/fetch-error.test.ts && bun run typecheck`
Expected: 4 pass; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add lib/fetch-error.ts actions/mock-time.ts tests/fetch-error.test.ts
git commit -m "refactor: share describeFetchError across HTTP integrations"
```

---

### Task 2: `mail` capability

**Files:**
- Modify: `lib/roles.ts:110-131`
- Test: `tests/roles.test.ts:242-271` (MATRIX)

**Interfaces:**
- Produces: `Capability` union now includes `"mail"`; `roleHasCapability(role, "mail")` true for member/maintainer/admin.

- [ ] **Step 1: Update the test matrix** — in `tests/roles.test.ts` add a `mail` entry to each role in `MATRIX`:

```ts
    [ROLE_VIEWER]: {
      read: true,
      "issue.edit": false,
      "kb.edit": false,
      mail: false,
      "ops.destructive": false,
      admin: false,
    },
    [ROLE_MEMBER]: {
      read: true,
      "issue.edit": true,
      "kb.edit": true,
      mail: true,
      "ops.destructive": false,
      admin: false,
    },
    [ROLE_MAINTAINER]: {
      read: true,
      "issue.edit": true,
      "kb.edit": true,
      mail: true,
      "ops.destructive": true,
      admin: false,
    },
    [ROLE_ADMIN]: {
      read: true,
      "issue.edit": true,
      "kb.edit": true,
      mail: true,
      "ops.destructive": true,
      admin: true,
    },
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/roles.test.ts`
Expected: FAIL — typecheck-level error or "covers every role and capability" mismatch (`mail` not in `CAPABILITIES`).

- [ ] **Step 3: Implement in `lib/roles.ts`**

Comment block above `CAPABILITIES` gains one line, and the arrays gain `mail`:

```ts
//   read             — view issues, knowledge, dashboards
//   issue.edit       — create/edit issues
//   kb.edit          — create/edit knowledge documents
//   mail             — read/delete the email an environment sent (Mailpit)
//   ops.destructive  — backup/restore/create/drop DB, mock time
//   admin            — servers, storage, users, project CRUD, membership
export const CAPABILITIES = [
  "read",
  "issue.edit",
  "kb.edit",
  "mail",
  "ops.destructive",
  "admin",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_MIN_ROLE: Record<Capability, UserRole> = {
  read: ROLE_VIEWER,
  "issue.edit": ROLE_MEMBER,
  "kb.edit": ROLE_MEMBER,
  // Captured mail carries OTPs and reset links, so viewers don't get it.
  mail: ROLE_MEMBER,
  "ops.destructive": ROLE_MAINTAINER,
  admin: ROLE_ADMIN,
};
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/roles.test.ts && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/roles.ts tests/roles.test.ts
git commit -m "feat: add mail capability for members and above"
```

---

### Task 3: `environment_mailpit` table and `hasMailpit` on environment list items

**Files:**
- Create: `drizzle/20261002000000_mailpit/migration.sql`
- Modify: `lib/db/schema.ts` (table after `environmentServices`; types near `EnvironmentListItem` ~line 1211)
- Modify: `actions/environments.ts:126-165` (`listEnvironments` select)
- Modify: `lib/environments.ts` (add `environmentName`)

**Interfaces:**
- Produces:
  - `environmentMailpit` table: `{ environmentId: string; url: string; username: string | null; password: string | null; updatedAt: Date }`
  - `type EnvironmentMailpit`
  - `EnvironmentListItem` gains `hasMailpit: boolean`
  - `environmentName(id: string): Promise<string | undefined>` from `@/lib/environments`

- [ ] **Step 1: Add the table to `lib/db/schema.ts`** directly after the `environmentServices` table definition:

```ts
// Mailpit connection for one environment: 1:1, row present = integration on.
// A separate table rather than columns on `environments` because whole
// environment rows reach the client in several places (listEnvironments,
// project catalog relations, create/update results); a secret column there
// would leak into RSC payloads.
export const environmentMailpit = pgTable("environment_mailpit", {
  environmentId: uuid("environment_id")
    .primaryKey()
    .references(() => environments.id, { onDelete: "cascade" }),
  // Base URL of the Mailpit UI/API, including any webroot
  // (e.g. `https://mail-qa.example.com/` or `http://10.0.0.5:8025`).
  url: text("url").notNull(),
  // Basic Auth for Mailpit's --ui-auth-file. Null username = no auth.
  username: text("username"),
  // Encrypted at rest via lib/secrets.ts; decrypted only in
  // lib/mailpit/config#loadMailpitConfig.
  password: text("password"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```

And next to the other environment types:

```ts
export type EnvironmentMailpit = InferSelectModel<typeof environmentMailpit>;
```

Change `EnvironmentListItem`:

```ts
// An environment summary plus its owning project's issue key, for readable-URL
// link builders (/[key]/[slug]/…), and whether a Mailpit is connected (drives
// the sidebar's Mail entry). Credential-free.
export type EnvironmentListItem = EnvironmentSummary & {
  key: string;
  hasMailpit: boolean;
};
```

- [ ] **Step 2: Write the migration** — `drizzle/20261002000000_mailpit/migration.sql`

```sql
-- Mailpit inbox integration: one optional connection per environment.
--
-- A 1:1 side table instead of columns on "environments": whole environment
-- rows are sent to client components in several places, and a secret column
-- there would end up (encrypted) in RSC payloads. Row present = enabled;
-- deleting the environment deletes its Mailpit connection.
--
-- "password" is encrypted at rest by lib/secrets.ts (`enc:v1:` envelope), the
-- same treatment as servers.password and environment_services.db_password.
BEGIN;

CREATE TABLE IF NOT EXISTS "environment_mailpit" (
  "environment_id" uuid PRIMARY KEY NOT NULL,
  "url" text NOT NULL,
  "username" text,
  "password" text,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "environment_mailpit_environment_id_environments_id_fk"
    FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id")
    ON DELETE cascade ON UPDATE no action
);

COMMIT;
```

- [ ] **Step 3: Add `hasMailpit` to `listEnvironments`** in `actions/environments.ts`:
  - Add `environmentMailpit` to the `@/lib/db/schema` value import.
  - Add this field to the `.select({ ... })` object, after `dbName`:

```ts
        // Sidebar's Mail entry. EXISTS, not a join, so the secret columns
        // never enter this client-bound projection.
        hasMailpit: sql<boolean>`exists (select 1 from ${environmentMailpit} where ${environmentMailpit.environmentId} = ${environments.id})`,
```

- [ ] **Step 4: Add `environmentName` to `lib/environments.ts`** (append; add `eq` from `drizzle-orm` and `environments` from `@/lib/db/schema` to imports):

```ts
/** An environment's display name, for activity-log params. */
export async function environmentName(id: string): Promise<string | undefined> {
  const [row] = await db
    .select({ name: environments.name })
    .from(environments)
    .where(eq(environments.id, id))
    .limit(1);
  return row?.name;
}
```

- [ ] **Step 5: Verify**

Run: `bun run typecheck && bun test`
Expected: clean; all existing tests pass. If anything else constructs `EnvironmentListItem` literals, typecheck points to it; add `hasMailpit: false` there.

If a local dev Postgres is running (`docker compose up -d postgres`) with `DATABASE_URL` pointing at it, also run `bun run db:migrate` and confirm `\d environment_mailpit` in psql. Skip this against any shared or prod DB.

- [ ] **Step 6: Commit**

```bash
git add lib/db/schema.ts drizzle/20261002000000_mailpit actions/environments.ts lib/environments.ts
git commit -m "feat: add environment_mailpit table and hasMailpit list flag"
```

---

### Task 4: Mailpit response schemas and HTTP client

**Files:**
- Create: `lib/mailpit/schemas.ts` (isomorphic: types + zod + page size)
- Create: `lib/mailpit/client.ts` (`server-only`)
- Create: `tests/fixtures/mailpit-messages.json`, `tests/fixtures/mailpit-message.json`
- Test: `tests/mailpit-client.test.ts`

**Interfaces:**
- Consumes: `describeFetchError` (Task 1).
- Produces (`@/lib/mailpit/schemas`): `MAIL_PAGE_SIZE = 50`; zod schemas `messagesPageSchema`, `mailMessageSchema`, `messageHeadersSchema`, `mailpitInfoSchema`; types `MailAddress`, `MessageSummary`, `MessagesPage`, `MailAttachment`, `MailMessage`, `MailpitInfo`.
- Produces (`@/lib/mailpit/client`):
  - `type MailpitConfig = { url: string; username: string | null; password: string | null }`
  - `class MailpitError extends Error { status: number | undefined }`
  - `mailpitUrl(base, path, params?) => string`
  - `mailpitEventsUrl(base) => string`
  - `mailpitAuthHeaders(cfg) => Record<string, string>`
  - `describeMailpitStatus(status, statusText) => string`
  - `getMailpitInfo(cfg) => Promise<MailpitInfo>`
  - `listMailpitMessages(cfg, { query, start }) => Promise<MessagesPage>`
  - `getMailpitMessage(cfg, id) => Promise<MailMessage>`
  - `getMailpitHeaders(cfg, id) => Promise<Record<string, string[]>>`
  - `getMailpitRaw(cfg, id) => Promise<Response>`
  - `getMailpitPart(cfg, id, partId) => Promise<Response>`
  - `deleteMailpitMessages(cfg, ids: string[] | "all") => Promise<void>`
  - `deleteMailpitSearch(cfg, query) => Promise<void>`

- [ ] **Step 1: Write fixtures**

`tests/fixtures/mailpit-messages.json`:

```json
{
  "total": 3,
  "unread": 1,
  "messages_count": 2,
  "messages_unread": 1,
  "start": 0,
  "tags": [],
  "messages": [
    {
      "ID": "VjkzFzyhPMWm5kBoEygbAz",
      "MessageID": "a1@app.test",
      "Read": false,
      "From": { "Name": "App", "Address": "noreply@app.test" },
      "To": [{ "Name": "", "Address": "qa@example.com" }],
      "Cc": null,
      "Bcc": null,
      "ReplyTo": [],
      "Subject": "Reset your password",
      "Created": "2026-10-02T03:04:05.678Z",
      "Username": "",
      "Tags": [],
      "Size": 4096,
      "Attachments": 1,
      "Snippet": "Click the link below to reset"
    },
    {
      "ID": "Q2bJw7oYbq7fJ3xYfB4vNk",
      "MessageID": "a2@app.test",
      "Read": true,
      "From": null,
      "To": null,
      "Cc": null,
      "Bcc": null,
      "ReplyTo": null,
      "Subject": "",
      "Created": "2026-10-02T03:00:00.000Z",
      "Username": "",
      "Tags": [],
      "Size": 512,
      "Attachments": 0,
      "Snippet": ""
    }
  ]
}
```

`tests/fixtures/mailpit-message.json`:

```json
{
  "ID": "VjkzFzyhPMWm5kBoEygbAz",
  "MessageID": "a1@app.test",
  "From": { "Name": "App", "Address": "noreply@app.test" },
  "To": [{ "Name": "", "Address": "qa@example.com" }],
  "Cc": null,
  "Bcc": null,
  "ReplyTo": [],
  "ReturnPath": "noreply@app.test",
  "Subject": "Reset your password",
  "ListUnsubscribe": { "Header": "", "Links": [], "Errors": "", "HeaderPost": "" },
  "Date": "2026-10-02T03:04:05Z",
  "Tags": [],
  "Username": "",
  "Text": "Click the link below to reset",
  "HTML": "<html><head><title>x</title></head><body><img src=\"cid:logo@app\"><a href=\"https://app.test/reset?t=1\">Reset</a></body></html>",
  "Size": 4096,
  "Inline": [
    { "PartID": "1.2", "FileName": "logo.png", "ContentType": "image/png", "ContentID": "logo@app", "Size": 120, "Checksums": {} }
  ],
  "Attachments": [
    { "PartID": "2", "FileName": "invoice.pdf", "ContentType": "application/pdf", "ContentID": "", "Size": 2048, "Checksums": {} }
  ]
}
```

- [ ] **Step 2: Write the failing test** — `tests/mailpit-client.test.ts`

```ts
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import messageFixture from "./fixtures/mailpit-message.json";
import messagesFixture from "./fixtures/mailpit-messages.json";
import {
  deleteMailpitMessages,
  describeMailpitStatus,
  getMailpitMessage,
  listMailpitMessages,
  type MailpitConfig,
  MailpitError,
  mailpitAuthHeaders,
  mailpitEventsUrl,
  mailpitUrl,
} from "@/lib/mailpit/client";
import { mailMessageSchema, messagesPageSchema } from "@/lib/mailpit/schemas";

const cfg: MailpitConfig = {
  url: "https://mail.test/mailpit",
  username: "qa",
  password: "secret",
};

describe("mailpitUrl", () => {
  it("joins onto a bare origin", () => {
    expect(mailpitUrl("http://10.0.0.5:8025", "api/v1/info")).toBe(
      "http://10.0.0.5:8025/api/v1/info"
    );
  });

  it("keeps a webroot without a trailing slash", () => {
    expect(mailpitUrl("https://mail.test/mailpit", "api/v1/info")).toBe(
      "https://mail.test/mailpit/api/v1/info"
    );
  });

  it("keeps a webroot with a trailing slash and a leading-slash path", () => {
    expect(mailpitUrl("https://mail.test/mailpit/", "/api/v1/info")).toBe(
      "https://mail.test/mailpit/api/v1/info"
    );
  });

  it("encodes params and drops empty ones", () => {
    expect(
      mailpitUrl("https://mail.test", "api/v1/search", {
        query: "to:a@b.c is:unread",
        start: 0,
        limit: 50,
        tz: "",
        skip: undefined,
      })
    ).toBe(
      "https://mail.test/api/v1/search?query=to%3Aa%40b.c+is%3Aunread&start=0&limit=50"
    );
  });
});

describe("mailpitEventsUrl", () => {
  it("maps http to ws", () => {
    expect(mailpitEventsUrl("http://10.0.0.5:8025")).toBe(
      "ws://10.0.0.5:8025/api/events"
    );
  });

  it("maps https to wss and keeps the webroot", () => {
    expect(mailpitEventsUrl("https://mail.test/mailpit")).toBe(
      "wss://mail.test/mailpit/api/events"
    );
  });
});

describe("mailpitAuthHeaders", () => {
  it("is empty without a username", () => {
    expect(
      mailpitAuthHeaders({ url: "http://x.test", username: null, password: "p" })
    ).toEqual({});
  });

  it("builds Basic auth", () => {
    expect(mailpitAuthHeaders(cfg)).toEqual({
      Authorization: "Basic cWE6c2VjcmV0",
    });
  });
});

describe("describeMailpitStatus", () => {
  it("explains auth failures", () => {
    expect(describeMailpitStatus(401, "Unauthorized")).toContain(
      "authentication failed"
    );
  });

  it("falls back to the status line", () => {
    expect(describeMailpitStatus(500, "Internal Server Error")).toBe(
      "Mailpit responded 500 Internal Server Error"
    );
  });
});

describe("schemas", () => {
  it("normalises null address lists to []", () => {
    const page = messagesPageSchema.parse(messagesFixture);
    expect(page.messages).toHaveLength(2);
    expect(page.messages[1]?.To).toEqual([]);
    expect(page.messages[1]?.From).toBeNull();
  });

  it("parses a full message", () => {
    const message = mailMessageSchema.parse(messageFixture);
    expect(message.Cc).toEqual([]);
    expect(message.Inline[0]?.ContentID).toBe("logo@app");
    expect(message.Attachments[0]?.FileName).toBe("invoice.pdf");
  });
});

describe("requests", () => {
  afterEach(() => {
    mock.restore();
  });

  it("uses the search endpoint with auth when a query is given", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(messagesFixture)
    );
    const page = await listMailpitMessages(cfg, { query: "is:unread", start: 50 });
    expect(page.messages_count).toBe(2);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://mail.test/mailpit/api/v1/search?start=50&limit=50&query=is%3Aunread"
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Basic cWE6c2VjcmV0"
    );
  });

  it("uses the messages endpoint without a query", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(messagesFixture)
    );
    await listMailpitMessages(cfg, { query: "", start: 0 });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://mail.test/mailpit/api/v1/messages?start=0&limit=50"
    );
  });

  it("maps 401 to a MailpitError carrying the status", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 401, statusText: "Unauthorized" })
    );
    const err = await getMailpitMessage(cfg, "abc").catch((e) => e);
    expect(err).toBeInstanceOf(MailpitError);
    expect(err.status).toBe(401);
  });

  it("maps network failures through describeFetchError", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })
    );
    const err = await getMailpitMessage(cfg, "abc").catch((e) => e);
    expect(err).toBeInstanceOf(MailpitError);
    expect(err.message).toBe("ECONNREFUSED");
  });

  it("rejects malformed JSON shapes", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ nope: 1 }));
    const err = await getMailpitMessage(cfg, "abc").catch((e) => e);
    expect(err).toBeInstanceOf(MailpitError);
    expect(err.message).toBe("Unexpected response from Mailpit");
  });

  it("never turns an empty selection into delete-all", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok")
    );
    await expect(deleteMailpitMessages(cfg, [])).rejects.toBeInstanceOf(
      MailpitError
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends an explicit empty IDs list only for 'all'", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok")
    );
    await deleteMailpitMessages(cfg, "all");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mail.test/mailpit/api/v1/messages");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBe('{"IDs":[]}');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/mailpit-client.test.ts`
Expected: FAIL — `Cannot find module '@/lib/mailpit/client'`.

- [ ] **Step 4: Create `lib/mailpit/schemas.ts`**

```ts
import { z } from "zod";

// Response shapes of the Mailpit REST API (v1) — only the fields OpsDeck
// renders. Isomorphic: the inbox's client components import the types and
// MAIL_PAGE_SIZE from here, so nothing server-only may be imported.

export const MAIL_PAGE_SIZE = 50;

const addressSchema = z.object({ Name: z.string(), Address: z.string() });

// Go encodes a nil slice as `null`; normalise to [] so callers never branch.
function list<T extends z.ZodType>(item: T) {
  return z
    .array(item)
    .nullable()
    .transform((v) => v ?? []);
}

export const messageSummarySchema = z.object({
  ID: z.string(),
  Read: z.boolean(),
  From: addressSchema.nullable(),
  To: list(addressSchema),
  Subject: z.string(),
  Created: z.string(),
  Size: z.number(),
  Attachments: z.number(),
  Snippet: z.string(),
});

export const messagesPageSchema = z.object({
  total: z.number(),
  unread: z.number(),
  // Number of messages matching the current listing/search (pagination total).
  messages_count: z.number(),
  start: z.number(),
  messages: list(messageSummarySchema),
});

export const attachmentSchema = z.object({
  PartID: z.string(),
  FileName: z.string(),
  ContentType: z.string(),
  ContentID: z.string(),
  Size: z.number(),
});

export const mailMessageSchema = z.object({
  ID: z.string(),
  MessageID: z.string(),
  From: addressSchema.nullable(),
  To: list(addressSchema),
  Cc: list(addressSchema),
  Bcc: list(addressSchema),
  ReplyTo: list(addressSchema),
  Subject: z.string(),
  Date: z.string(),
  Text: z.string(),
  HTML: z.string(),
  Size: z.number(),
  Inline: list(attachmentSchema),
  Attachments: list(attachmentSchema),
});

export const messageHeadersSchema = z.record(z.string(), z.array(z.string()));

export const mailpitInfoSchema = z.object({
  Version: z.string(),
  Messages: z.number(),
  Unread: z.number(),
});

export type MailAddress = z.infer<typeof addressSchema>;
export type MessageSummary = z.infer<typeof messageSummarySchema>;
export type MessagesPage = z.infer<typeof messagesPageSchema>;
export type MailAttachment = z.infer<typeof attachmentSchema>;
export type MailMessage = z.infer<typeof mailMessageSchema>;
export type MailpitInfo = z.infer<typeof mailpitInfoSchema>;
```

- [ ] **Step 5: Create `lib/mailpit/client.ts`**

```ts
import "server-only";

import type { z } from "zod";
import { describeFetchError } from "@/lib/fetch-error";
import {
  MAIL_PAGE_SIZE,
  type MailMessage,
  type MailpitInfo,
  type MessagesPage,
  mailMessageSchema,
  mailpitInfoSchema,
  messageHeadersSchema,
  messagesPageSchema,
} from "./schemas";

// Thin typed client for one environment's Mailpit REST API. The config always
// comes from lib/mailpit/config (the DB), never from the browser — that's what
// keeps these server-side fetches from being pointed at arbitrary hosts.

export type MailpitConfig = {
  url: string;
  username: string | null;
  password: string | null;
};

export class MailpitError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "MailpitError";
    this.status = status;
  }
}

const API_TIMEOUT_MS = 10_000;
// Raw sources and attachments stream through us; give big ones room.
const DOWNLOAD_TIMEOUT_MS = 60_000;

type Params = Record<string, string | number | undefined>;

export function mailpitUrl(base: string, path: string, params: Params = {}) {
  // Treat the base as a directory so a webroot (`/mailpit`) survives: URL
  // resolution would otherwise replace its last segment.
  const root = base.endsWith("/") ? base : `${base}/`;
  const url = new URL(path.replace(/^\/+/, ""), root);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function mailpitEventsUrl(base: string): string {
  const url = new URL(mailpitUrl(base, "api/events"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function mailpitAuthHeaders(cfg: MailpitConfig): Record<string, string> {
  if (!cfg.username) return {};
  const token = Buffer.from(`${cfg.username}:${cfg.password ?? ""}`).toString(
    "base64"
  );
  return { Authorization: `Basic ${token}` };
}

export function describeMailpitStatus(status: number, statusText: string) {
  if (status === 401 || status === 403) {
    return "Mailpit authentication failed — check the environment's Mailpit settings";
  }
  if (status === 404) return "Not found in Mailpit";
  return `Mailpit responded ${status} ${statusText}`.trim();
}

type RequestOptions = {
  method?: "GET" | "DELETE";
  params?: Params;
  body?: unknown;
  timeoutMs?: number;
};

async function request(
  cfg: MailpitConfig,
  path: string,
  opts: RequestOptions = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? API_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(mailpitUrl(cfg.url, path, opts.params), {
      method: opts.method ?? "GET",
      headers: {
        ...mailpitAuthHeaders(cfg),
        ...(opts.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "TimeoutError") {
      throw new MailpitError(
        `Mailpit did not respond within ${timeoutMs / 1000}s`
      );
    }
    throw new MailpitError(describeFetchError(err));
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new MailpitError(
      describeMailpitStatus(res.status, res.statusText),
      res.status
    );
  }
  return res;
}

async function parse<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new MailpitError("Unexpected response from Mailpit");
  return parsed.data;
}

const messagePath = (id: string) => `api/v1/message/${encodeURIComponent(id)}`;

export async function getMailpitInfo(cfg: MailpitConfig): Promise<MailpitInfo> {
  return parse(await request(cfg, "api/v1/info"), mailpitInfoSchema);
}

export async function listMailpitMessages(
  cfg: MailpitConfig,
  { query, start }: { query: string; start: number }
): Promise<MessagesPage> {
  const params = { start, limit: MAIL_PAGE_SIZE };
  const res = query
    ? await request(cfg, "api/v1/search", { params: { ...params, query } })
    : await request(cfg, "api/v1/messages", { params });
  return parse(res, messagesPageSchema);
}

// Note: Mailpit marks the message read as a side effect of this GET.
export async function getMailpitMessage(
  cfg: MailpitConfig,
  id: string
): Promise<MailMessage> {
  return parse(await request(cfg, messagePath(id)), mailMessageSchema);
}

export async function getMailpitHeaders(
  cfg: MailpitConfig,
  id: string
): Promise<Record<string, string[]>> {
  return parse(
    await request(cfg, `${messagePath(id)}/headers`),
    messageHeadersSchema
  );
}

export function getMailpitRaw(cfg: MailpitConfig, id: string) {
  return request(cfg, `${messagePath(id)}/raw`, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
}

export function getMailpitPart(cfg: MailpitConfig, id: string, partId: string) {
  return request(cfg, `${messagePath(id)}/part/${encodeURIComponent(partId)}`, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
}

export async function deleteMailpitMessages(
  cfg: MailpitConfig,
  ids: string[] | "all"
): Promise<void> {
  // Mailpit reads an empty IDs list as "delete everything". Only an explicit
  // "all" may produce one — an empty selection is a caller bug.
  if (ids !== "all" && ids.length === 0) {
    throw new MailpitError("No messages selected");
  }
  const res = await request(cfg, "api/v1/messages", {
    method: "DELETE",
    body: { IDs: ids === "all" ? [] : ids },
  });
  await res.body?.cancel();
}

export async function deleteMailpitSearch(
  cfg: MailpitConfig,
  query: string
): Promise<void> {
  if (!query.trim()) throw new MailpitError("Empty search");
  const res = await request(cfg, "api/v1/search", {
    method: "DELETE",
    params: { query },
  });
  await res.body?.cancel();
}
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/mailpit-client.test.ts && bun run typecheck && bun run lint`
Expected: all pass. If JSON imports need `resolveJsonModule`, confirm `tsconfig.json` has it. It is the Next default; if it's missing, load the fixtures with `await Bun.file(...).json()` in a `beforeAll`.

- [ ] **Step 7: Commit**

```bash
git add lib/mailpit/schemas.ts lib/mailpit/client.ts tests/mailpit-client.test.ts tests/fixtures/mailpit-messages.json tests/fixtures/mailpit-message.json
git commit -m "feat: add typed Mailpit REST client"
```

---

### Task 5: Email HTML preparation for the sandboxed iframe

**Files:**
- Create: `lib/mailpit/html.ts`
- Test: `tests/mailpit-html.test.ts`

**Interfaces:**
- Consumes: `MailAttachment` (Task 4).
- Produces:
  - `MAX_INLINE_PART_BYTES = 2 MiB`, `MAX_INLINE_TOTAL_BYTES = 10 MiB`
  - `HTML_PRELUDE: string`
  - `referencedCids(html) => Set<string>`
  - `pickInlineParts(inline: MailAttachment[], referenced: Set<string>) => MailAttachment[]`
  - `toDataUri(contentType, bytes: Uint8Array) => string`
  - `inlineCids(html, dataUris: Map<string /*ContentID*/, string>) => string`
  - `withPrelude(html) => string`

- [ ] **Step 1: Write the failing test** — `tests/mailpit-html.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import {
  HTML_PRELUDE,
  inlineCids,
  MAX_INLINE_PART_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  pickInlineParts,
  referencedCids,
  toDataUri,
  withPrelude,
} from "@/lib/mailpit/html";
import type { MailAttachment } from "@/lib/mailpit/schemas";

function part(contentId: string, size = 100): MailAttachment {
  return {
    PartID: contentId,
    FileName: `${contentId}.png`,
    ContentType: "image/png",
    ContentID: contentId,
    Size: size,
  };
}

describe("referencedCids", () => {
  it("finds cid refs in src attributes and CSS url()", () => {
    const html = `<img src="cid:logo@app"><div style="background:url(cid:BG)"></div><img src='cid:a%40b'>`;
    expect([...referencedCids(html)].sort()).toEqual(["a@b", "bg", "logo@app"]);
  });
});

describe("pickInlineParts", () => {
  it("keeps only referenced parts", () => {
    const picked = pickInlineParts([part("logo@app"), part("unused")], new Set(["logo@app"]));
    expect(picked.map((p) => p.ContentID)).toEqual(["logo@app"]);
  });

  it("matches Content-IDs wrapped in angle brackets", () => {
    const picked = pickInlineParts([part("<logo@app>")], new Set(["logo@app"]));
    expect(picked).toHaveLength(1);
  });

  it("skips parts over the per-part cap", () => {
    const picked = pickInlineParts(
      [part("big", MAX_INLINE_PART_BYTES + 1)],
      new Set(["big"])
    );
    expect(picked).toEqual([]);
  });

  it("stops adding once the total cap would be exceeded", () => {
    const size = MAX_INLINE_PART_BYTES;
    const count = MAX_INLINE_TOTAL_BYTES / size + 1;
    const parts = Array.from({ length: count }, (_, i) => part(`p${i}`, size));
    const picked = pickInlineParts(parts, new Set(parts.map((p) => p.ContentID)));
    expect(picked).toHaveLength(count - 1);
  });
});

describe("toDataUri", () => {
  it("base64-encodes with the content type", () => {
    expect(toDataUri("image/png", new Uint8Array([1, 2, 3]))).toBe(
      "data:image/png;base64,AQID"
    );
  });

  it("refuses content types that could break out of the attribute", () => {
    expect(toDataUri('image/png" onerror="x', new Uint8Array([1]))).toBe(
      "data:application/octet-stream;base64,AQ=="
    );
  });
});

describe("inlineCids", () => {
  it("replaces known refs and leaves unknown ones", () => {
    const html = `<img src="cid:logo@app"><img src="cid:missing">`;
    const out = inlineCids(html, new Map([["<logo@app>", "data:image/png;base64,AQID"]]));
    expect(out).toBe(`<img src="data:image/png;base64,AQID"><img src="cid:missing">`);
  });
});

describe("withPrelude", () => {
  it("injects right after an existing <head>", () => {
    const out = withPrelude(`<html><head lang="en"><title>x</title></head><body>b</body></html>`);
    expect(out).toBe(
      `<html><head lang="en">${HTML_PRELUDE}<title>x</title></head><body>b</body></html>`
    );
  });

  it("wraps a fragment in a document", () => {
    expect(withPrelude("<p>hi</p>")).toBe(
      `<!doctype html><html><head>${HTML_PRELUDE}</head><body><p>hi</p></body></html>`
    );
  });

  it("blocks scripts and sends links to a new tab", () => {
    expect(HTML_PRELUDE).toContain("script-src 'none'");
    expect(HTML_PRELUDE).toContain('<base target="_blank">');
    expect(HTML_PRELUDE).toContain('content="no-referrer"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mailpit-html.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `lib/mailpit/html.ts`**

```ts
import type { MailAttachment } from "./schemas";

// Prepares a message's HTML for `<iframe srcdoc sandbox>` in the inbox. The
// app-wide `frame-ancestors 'none'` header rules out pointing an iframe at an
// OpsDeck route, and a sandboxed (opaque-origin) frame couldn't send the
// session cookie to fetch inline parts anyway — so inline images are baked
// in as data: URIs server-side.

export const MAX_INLINE_PART_BYTES = 2 * 1024 * 1024;
export const MAX_INLINE_TOTAL_BYTES = 10 * 1024 * 1024;

// Defence in depth on top of the sandbox (which already blocks scripts): no
// scripts/plugins/form posts, no Referer leaking the OpsDeck URL to remote
// image hosts, and links open in a new tab instead of navigating the frame.
export const HTML_PRELUDE =
  `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; form-action 'none'">` +
  `<meta name="referrer" content="no-referrer">` +
  `<base target="_blank">`;

const CID_RE = /cid:([^"'\s)>]+)/gi;
const SAFE_CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

function normaliseCid(id: string): string {
  let value = id;
  try {
    value = decodeURIComponent(id);
  } catch {
    // keep the raw value
  }
  return value.replace(/^<|>$/g, "").toLowerCase();
}

export function referencedCids(html: string): Set<string> {
  const found = new Set<string>();
  for (const match of html.matchAll(CID_RE)) {
    if (match[1]) found.add(normaliseCid(match[1]));
  }
  return found;
}

export function pickInlineParts(
  inline: MailAttachment[],
  referenced: Set<string>
): MailAttachment[] {
  const picked: MailAttachment[] = [];
  let total = 0;
  for (const part of inline) {
    if (!part.ContentID || !referenced.has(normaliseCid(part.ContentID))) {
      continue;
    }
    if (part.Size > MAX_INLINE_PART_BYTES) continue;
    if (total + part.Size > MAX_INLINE_TOTAL_BYTES) continue;
    total += part.Size;
    picked.push(part);
  }
  return picked;
}

export function toDataUri(contentType: string, bytes: Uint8Array): string {
  // The type comes from the (untrusted) email; anything odd could break out
  // of the src attribute, so fall back to a neutral type.
  const type = SAFE_CONTENT_TYPE.test(contentType)
    ? contentType
    : "application/octet-stream";
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function inlineCids(html: string, dataUris: Map<string, string>): string {
  const lookup = new Map(
    [...dataUris].map(([cid, uri]) => [normaliseCid(cid), uri])
  );
  return html.replace(
    CID_RE,
    (match, id: string) => lookup.get(normaliseCid(id)) ?? match
  );
}

export function withPrelude(html: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + HTML_PRELUDE + html.slice(at);
  }
  return `<!doctype html><html><head>${HTML_PRELUDE}</head><body>${html}</body></html>`;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/mailpit-html.test.ts && bun run lint`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/mailpit/html.ts tests/mailpit-html.test.ts
git commit -m "feat: prepare Mailpit HTML for a sandboxed srcdoc iframe"
```

---

### Task 6: Mailpit config loader and settings actions

**Files:**
- Create: `lib/mailpit/config.ts`
- Create: `actions/mailpit-settings.ts`
- Modify: `lib/validation.ts` (append `mailpitSettingsSchema`)
- Modify: `app/[locale]/admin/activity/page.tsx` (two cases)
- Modify: `messages/{ar,en,es,id,zh}.json` (`activity.mailpitConfigured`, `activity.mailpitRemoved`)
- Test: `tests/validation.test.ts`, `tests/mailpit-config.test.ts`

**Interfaces:**
- Consumes:
  - `environmentMailpit` and `environmentName` (Task 3)
  - `getMailpitInfo`, `MailpitError`, `MailpitConfig` (Task 4)
- Produces:
  - `loadMailpitConfig(environmentId: string): Promise<MailpitConfig | null>` (`@/lib/mailpit/config`, server-only)
  - `shouldReuseStoredPassword(input: { url: string; username: string | null; password?: string }, stored: MailpitConfig | null): boolean` (pure, same module)
  - `mailpitSettingsSchema` and `type MailpitSettingsInput` (`@/lib/validation`)
  - From `@/actions/mailpit-settings`:
    - `type MailpitSettings = { url: string; username: string | null; hasPassword: boolean }`
    - `getMailpitSettings(environmentId): Promise<MailpitSettings | null>`
    - `saveMailpitSettings(environmentId, data: unknown): Promise<ActionResponse>`
    - `testMailpitConnection(environmentId, data: unknown): Promise<MailpitTestResult>`, where `MailpitTestResult = { success: true; data: { version: string; messages: number } } | { success: false; error: string }`

- [ ] **Step 1: Write failing tests**

Append to `tests/validation.test.ts` (add `mailpitSettingsSchema` to the import list):

```ts
describe("mailpitSettingsSchema", () => {
  it.each([
    "http://10.0.0.5:8025",
    "https://mail-qa.example.com/",
    "https://example.com/mailpit",
    "",
  ])("accepts url %p", (url) => {
    expect(mailpitSettingsSchema.safeParse({ url }).success).toBe(true);
  });

  it.each(["ftp://x.test", "javascript:alert(1)", "not a url", "file:///etc/passwd"])(
    "rejects url %p",
    (url) => {
      expect(mailpitSettingsSchema.safeParse({ url }).success).toBe(false);
    }
  );

  it("keeps password undefined when omitted (blank = keep)", () => {
    const parsed = mailpitSettingsSchema.parse({ url: "http://x.test", username: "qa" });
    expect(parsed.password).toBeUndefined();
  });
});
```

Create `tests/mailpit-config.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { shouldReuseStoredPassword } from "@/lib/mailpit/config";

const stored = { url: "https://mail.test/", username: "qa", password: "s3cret" };

describe("shouldReuseStoredPassword", () => {
  it("reuses it for the same URL, a username, and a blank password", () => {
    expect(
      shouldReuseStoredPassword({ url: "https://mail.test/", username: "qa" }, stored)
    ).toBe(true);
  });

  it("never sends the stored password to a different URL", () => {
    expect(
      shouldReuseStoredPassword({ url: "https://evil.test/", username: "qa" }, stored)
    ).toBe(false);
  });

  it("does not reuse when a password was typed", () => {
    expect(
      shouldReuseStoredPassword(
        { url: "https://mail.test/", username: "qa", password: "new" },
        stored
      )
    ).toBe(false);
  });

  it("does not reuse without a username or without a stored row", () => {
    expect(shouldReuseStoredPassword({ url: "https://mail.test/", username: null }, stored)).toBe(false);
    expect(shouldReuseStoredPassword({ url: "https://mail.test/", username: "qa" }, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/validation.test.ts tests/mailpit-config.test.ts`
Expected: FAIL — missing exports/modules.

- [ ] **Step 3: Append to `lib/validation.ts`**

```ts
// Mailpit connection for one environment. Empty `url` = disconnect. An omitted
// `password` keeps the stored one ("blank = keep", like dbPassword).
export const mailpitSettingsSchema = z.object({
  url: z.union([
    z.literal(""),
    z.url({ protocol: /^https?$/ }).max(2048),
  ]),
  username: z.string().trim().max(255).nullish(),
  password: z.string().max(1024).optional(),
});
export type MailpitSettingsInput = z.infer<typeof mailpitSettingsSchema>;
```

- [ ] **Step 4: Create `lib/mailpit/config.ts`**

```ts
import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { environmentMailpit } from "@/lib/db/schema";
import { decryptNullable } from "@/lib/secrets";
import type { MailpitConfig } from "./client";

// SINGLE decryption boundary for Mailpit credentials, mirroring
// lib/environments#loadEnvironmentWithServers. The result carries a plaintext
// password: server-side callers only, never returned to a client component.
export async function loadMailpitConfig(
  environmentId: string
): Promise<MailpitConfig | null> {
  const [row] = await db
    .select()
    .from(environmentMailpit)
    .where(eq(environmentMailpit.environmentId, environmentId))
    .limit(1);
  if (!row) return null;
  return {
    url: row.url,
    username: row.username,
    password: decryptNullable(row.password),
  };
}

// "Test connection" with a blank password field should test the stored one —
// but only against the stored URL. Otherwise an admin could point the URL at
// a host they control and receive the stored password in the Basic header.
export function shouldReuseStoredPassword(
  input: { url: string; username: string | null; password?: string },
  stored: MailpitConfig | null
): boolean {
  return Boolean(
    stored?.password && input.username && !input.password && input.url === stored.url
  );
}
```

- [ ] **Step 5: Create `actions/mailpit-settings.ts`**

```ts
"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordActivity } from "@/lib/activity";
import { requireAdmin } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { environmentMailpit } from "@/lib/db/schema";
import { environmentName } from "@/lib/environments";
import { getMailpitInfo, MailpitError } from "@/lib/mailpit/client";
import {
  loadMailpitConfig,
  shouldReuseStoredPassword,
} from "@/lib/mailpit/config";
import { encryptSecret } from "@/lib/secrets";
import type { ActionResponse } from "@/lib/types";
import { mailpitSettingsSchema, uuidSchema } from "@/lib/validation";

// Credential-free projection for the settings form.
export type MailpitSettings = {
  url: string;
  username: string | null;
  hasPassword: boolean;
};

export type MailpitTestResult =
  | { success: true; data: { version: string; messages: number } }
  | { success: false; error: string };

export async function getMailpitSettings(
  environmentId: string
): Promise<MailpitSettings | null> {
  await requireAdmin();
  if (!uuidSchema.safeParse(environmentId).success) return null;
  const cfg = await loadMailpitConfig(environmentId);
  return cfg
    ? { url: cfg.url, username: cfg.username, hasPassword: Boolean(cfg.password) }
    : null;
}

export async function saveMailpitSettings(
  environmentId: string,
  data: unknown
): Promise<ActionResponse> {
  const session = await requireAdmin();
  if (!uuidSchema.safeParse(environmentId).success) {
    return { success: false, message: "Invalid environment id" };
  }
  const parsed = mailpitSettingsSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid Mailpit settings" };
  }
  const name = await environmentName(environmentId);
  if (!name) return { success: false, message: "Environment not found" };

  const { url, password } = parsed.data;
  const username = parsed.data.username?.trim() || null;
  try {
    if (!url) {
      const removed = await db
        .delete(environmentMailpit)
        .where(eq(environmentMailpit.environmentId, environmentId))
        .returning({ id: environmentMailpit.environmentId });
      if (removed.length > 0) {
        await recordActivity({
          actorId: session.user.id,
          action: "mailpit.removed",
          entityType: "environment",
          entityId: environmentId,
          data: { environment: name },
        });
      }
    } else {
      // No username = no Basic Auth, so any stored password goes with it.
      // Otherwise a blank password field keeps the stored one.
      const passwordPatch = !username
        ? { password: null }
        : password
          ? { password: encryptSecret(password) }
          : {};
      await db
        .insert(environmentMailpit)
        .values({ environmentId, url, username, ...passwordPatch })
        .onConflictDoUpdate({
          target: environmentMailpit.environmentId,
          set: { url, username, ...passwordPatch, updatedAt: sql`now()` },
        });
      await recordActivity({
        actorId: session.user.id,
        action: "mailpit.configured",
        entityType: "environment",
        entityId: environmentId,
        data: { environment: name, url },
      });
    }
  } catch (error) {
    console.error(`Failed to save Mailpit settings for ${environmentId}:`, error);
    return { success: false, message: "Failed to save Mailpit settings" };
  }

  // The sidebar's Mail entry reads hasMailpit from the layout-level list.
  revalidatePath("/", "layout");
  return {
    success: true,
    message: url ? "Mailpit settings saved" : "Mailpit disconnected",
  };
}

export async function testMailpitConnection(
  environmentId: string,
  data: unknown
): Promise<MailpitTestResult> {
  await requireAdmin();
  if (!uuidSchema.safeParse(environmentId).success) {
    return { success: false, error: "Invalid environment id" };
  }
  const parsed = mailpitSettingsSchema.safeParse(data);
  if (!parsed.success || !parsed.data.url) {
    return { success: false, error: "Enter a valid http(s) URL" };
  }
  const input = {
    url: parsed.data.url,
    username: parsed.data.username?.trim() || null,
    password: parsed.data.password,
  };
  const stored = await loadMailpitConfig(environmentId);
  const password = shouldReuseStoredPassword(input, stored)
    ? (stored?.password ?? null)
    : input.password || null;
  try {
    const info = await getMailpitInfo({
      url: input.url,
      username: input.username,
      password,
    });
    return { success: true, data: { version: info.Version, messages: info.Messages } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof MailpitError ? err.message : "Connection failed",
    };
  }
}
```

- [ ] **Step 6: Render the activity events** in `app/[locale]/admin/activity/page.tsx`. Add these cases to the `switch` before `case "terminal.open":`

```ts
    case "mailpit.configured":
      return t("mailpitConfigured", { actor, environment: String(d.environment) });
    case "mailpit.removed":
      return t("mailpitRemoved", { actor, environment: String(d.environment) });
```

- [ ] **Step 7: Add activity strings to all five locales.** Run this from the repo root. It inserts the keys into the `activity` object and preserves the files' existing 2-space formatting:

```bash
python3 - <<'PY'
import json
strings = {
  "en": {"mailpitConfigured": "{actor} connected Mailpit for {environment}", "mailpitRemoved": "{actor} disconnected Mailpit from {environment}"},
  "id": {"mailpitConfigured": "{actor} menghubungkan Mailpit untuk {environment}", "mailpitRemoved": "{actor} memutus Mailpit dari {environment}"},
  "es": {"mailpitConfigured": "{actor} conectó Mailpit para {environment}", "mailpitRemoved": "{actor} desconectó Mailpit de {environment}"},
  "ar": {"mailpitConfigured": "قام {actor} بربط Mailpit بالبيئة {environment}", "mailpitRemoved": "قام {actor} بفصل Mailpit عن البيئة {environment}"},
  "zh": {"mailpitConfigured": "{actor} 为 {environment} 连接了 Mailpit", "mailpitRemoved": "{actor} 断开了 {environment} 的 Mailpit"},
}
for loc, add in strings.items():
    p = f"messages/{loc}.json"
    d = json.load(open(p, encoding="utf-8"))
    d["activity"].update(add)
    open(p, "w", encoding="utf-8").write(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
PY
git diff --stat messages/
```

Expected: each locale file shows a small diff (only the added lines). If the diff is the whole file, the original formatting differs. Revert with `git checkout messages/`, then add the keys by hand with Edit.

- [ ] **Step 8: Run tests**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add lib/mailpit/config.ts actions/mailpit-settings.ts lib/validation.ts tests/validation.test.ts tests/mailpit-config.test.ts "app/[locale]/admin/activity/page.tsx" messages/
git commit -m "feat: add Mailpit settings actions with stored-password guard"
```

---

### Task 7: Mailpit settings card on the environment settings page

**Files:**
- Create: `components/mailpit-settings-form.tsx`
- Modify: `app/[locale]/[projectKey]/[envSlug]/settings/page.tsx`
- Modify: `messages/{ar,en,es,id,zh}.json` (new `mailpitSettings` namespace)

**Interfaces:**
- Consumes: `getMailpitSettings`, `saveMailpitSettings`, `testMailpitConnection`, `MailpitSettings` (Task 6).
- Produces: `<MailpitSettingsForm environmentId={string} settings={MailpitSettings | null} />`.

- [ ] **Step 1: Add the `mailpitSettings` namespace** (all locales):

```bash
python3 - <<'PY'
import json
ns = {
  "en": {"title": "Mailpit", "description": "Connect this environment's Mailpit so members can read the email it sends.", "url": "Mailpit URL", "urlHint": "Base URL of the Mailpit web UI, including any webroot (e.g. https://mail-qa.example.com/). Leave empty to disconnect.", "username": "Username (optional)", "password": "Password (optional)", "passwordKeepPlaceholder": "Leave blank to keep unchanged", "authHint": "Basic Auth credentials, if Mailpit runs with --ui-auth-file.", "save": "Save", "saving": "Saving…", "saved": "Mailpit settings saved", "removed": "Mailpit disconnected", "saveFailed": "Could not save Mailpit settings", "test": "Test connection", "testing": "Testing…", "testOk": "Connected — Mailpit {version}, {count, plural, one {# message} other {# messages}}"},
  "id": {"title": "Mailpit", "description": "Hubungkan Mailpit environment ini agar member bisa membaca email yang dikirimnya.", "url": "URL Mailpit", "urlHint": "URL dasar web UI Mailpit, termasuk webroot jika ada (mis. https://mail-qa.example.com/). Kosongkan untuk memutus koneksi.", "username": "Username (opsional)", "password": "Password (opsional)", "passwordKeepPlaceholder": "Kosongkan agar tidak berubah", "authHint": "Kredensial Basic Auth, jika Mailpit dijalankan dengan --ui-auth-file.", "save": "Simpan", "saving": "Menyimpan…", "saved": "Pengaturan Mailpit disimpan", "removed": "Mailpit diputus", "saveFailed": "Gagal menyimpan pengaturan Mailpit", "test": "Tes koneksi", "testing": "Mengetes…", "testOk": "Terhubung — Mailpit {version}, {count, plural, other {# pesan}}"},
  "es": {"title": "Mailpit", "description": "Conecta el Mailpit de este entorno para que los miembros puedan leer el correo que envía.", "url": "URL de Mailpit", "urlHint": "URL base de la interfaz web de Mailpit, incluido el webroot si lo hay (p. ej. https://mail-qa.example.com/). Déjala vacía para desconectar.", "username": "Usuario (opcional)", "password": "Contraseña (opcional)", "passwordKeepPlaceholder": "Déjala en blanco para no cambiarla", "authHint": "Credenciales Basic Auth, si Mailpit se ejecuta con --ui-auth-file.", "save": "Guardar", "saving": "Guardando…", "saved": "Configuración de Mailpit guardada", "removed": "Mailpit desconectado", "saveFailed": "No se pudo guardar la configuración de Mailpit", "test": "Probar conexión", "testing": "Probando…", "testOk": "Conectado — Mailpit {version}, {count, plural, one {# mensaje} other {# mensajes}}"},
  "ar": {"title": "Mailpit", "description": "اربط Mailpit الخاص بهذه البيئة ليتمكن الأعضاء من قراءة البريد الذي ترسله.", "url": "رابط Mailpit", "urlHint": "الرابط الأساسي لواجهة Mailpit، بما في ذلك المسار الجذري إن وجد (مثل https://mail-qa.example.com/). اتركه فارغًا لفصل الاتصال.", "username": "اسم المستخدم (اختياري)", "password": "كلمة المرور (اختياري)", "passwordKeepPlaceholder": "اتركه فارغًا للإبقاء عليه دون تغيير", "authHint": "بيانات Basic Auth إذا كان Mailpit يعمل مع --ui-auth-file.", "save": "حفظ", "saving": "جارٍ الحفظ…", "saved": "تم حفظ إعدادات Mailpit", "removed": "تم فصل Mailpit", "saveFailed": "تعذّر حفظ إعدادات Mailpit", "test": "اختبار الاتصال", "testing": "جارٍ الاختبار…", "testOk": "متصل — Mailpit {version}، {count, plural, one {رسالة واحدة} other {# رسائل}}"},
  "zh": {"title": "Mailpit", "description": "连接此环境的 Mailpit，让成员可以阅读它发送的邮件。", "url": "Mailpit 地址", "urlHint": "Mailpit 网页界面的基础地址，包含 webroot（如 https://mail-qa.example.com/）。留空则断开连接。", "username": "用户名（可选）", "password": "密码（可选）", "passwordKeepPlaceholder": "留空则保持不变", "authHint": "如果 Mailpit 使用 --ui-auth-file 运行，请填写 Basic Auth 凭据。", "save": "保存", "saving": "保存中…", "saved": "Mailpit 设置已保存", "removed": "已断开 Mailpit", "saveFailed": "无法保存 Mailpit 设置", "test": "测试连接", "testing": "测试中…", "testOk": "已连接 — Mailpit {version}，{count, plural, other {# 封邮件}}"},
}
for loc, add in ns.items():
    p = f"messages/{loc}.json"
    d = json.load(open(p, encoding="utf-8"))
    d["mailpitSettings"] = add
    open(p, "w", encoding="utf-8").write(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
PY
git diff --stat messages/
```

- [ ] **Step 2: Create `components/mailpit-settings-form.tsx`**

```tsx
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { PlugZap } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  type MailpitSettings,
  saveMailpitSettings,
  testMailpitConnection,
} from "@/actions/mailpit-settings";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";

export function MailpitSettingsForm({
  environmentId,
  settings,
}: {
  environmentId: string;
  settings: MailpitSettings | null;
}) {
  const t = useTranslations("mailpitSettings");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [testing, startTesting] = useTransition();

  const schema = z.object({
    url: z.union([
      z.literal(""),
      z
        .string()
        .trim()
        .url(tCommon("urlInvalid"))
        .refine((v) => /^https?:\/\//i.test(v), tCommon("urlInvalid")),
    ]),
    username: z.string(),
    // Blank = keep the stored password (see actions/mailpit-settings).
    password: z.string(),
  });
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      url: settings?.url ?? "",
      username: settings?.username ?? "",
      password: "",
    },
  });
  const url = useWatch({ control: form.control, name: "url" });
  const saving = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !saving);

  function payload(values: Values) {
    return {
      url: values.url.trim(),
      username: values.username.trim() || null,
      password: values.password || undefined,
    };
  }

  async function onSubmit(values: Values) {
    const result = await saveMailpitSettings(environmentId, payload(values));
    if (!result.success) {
      toast.error(result.message || t("saveFailed"));
      return;
    }
    toast.success(values.url.trim() ? t("saved") : t("removed"));
    form.reset({ ...values, password: "" });
    router.refresh();
  }

  function onTest() {
    startTesting(async () => {
      if (!(await form.trigger("url"))) return;
      const result = await testMailpitConnection(
        environmentId,
        payload(form.getValues())
      );
      if (result.success) {
        toast.success(
          t("testOk", {
            version: result.data.version,
            count: result.data.messages,
          })
        );
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-4"
      >
        <FormField
          control={form.control}
          name="url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("url")}</FormLabel>
              <FormControl>
                <Input
                  type="url"
                  placeholder="https://mail-qa.example.com/"
                  {...field}
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">{t("urlHint")}</p>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="username"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("username")}</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("password")}</FormLabel>
                <FormControl>
                  <PasswordInput
                    autoComplete="new-password"
                    placeholder={
                      settings?.hasPassword ? t("passwordKeepPlaceholder") : ""
                    }
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("authHint")}</p>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onTest}
            disabled={testing || saving || !url.trim()}
          >
            <PlugZap className="size-4" />
            {testing ? t("testing") : t("test")}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
```

- [ ] **Step 3: Wire it into the settings page**

In `app/[locale]/[projectKey]/[envSlug]/settings/page.tsx`:
- Add the imports:
  ```ts
  import { getMailpitSettings } from "@/actions/mailpit-settings";
  import { MailpitSettingsForm } from "@/components/mailpit-settings-form";
  ```
- Extend the `Promise.all`:
  ```ts
  const [environment, servers, projects, mailpit] = await Promise.all([
    getEnvironmentById(environmentId),
    getServers(),
    listProjects(),
    getMailpitSettings(environmentId),
  ]);
  ```
- Add `const tMailpit = await getTranslations("mailpitSettings");` next to the other translators.
- Insert this card between the edit card and the duplicate card inside `TabsContent value="config"`:
  ```tsx
  <Card>
    <CardHeader>
      <CardTitle>{tMailpit("title")}</CardTitle>
      <CardDescription>{tMailpit("description")}</CardDescription>
    </CardHeader>
    <CardContent>
      <MailpitSettingsForm
        environmentId={environment.id}
        settings={mailpit}
      />
    </CardContent>
  </Card>
  ```

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun run lint && bun test`
Expected: clean.

Manual check (dev server, `bun run dev`, admin login): open `/<KEY>/<env>/settings` and confirm:
- The Mailpit card renders.
- Test with an unreachable URL shows an `ECONNREFUSED`-style toast.

- [ ] **Step 5: Commit**

```bash
git add components/mailpit-settings-form.tsx "app/[locale]/[projectKey]/[envSlug]/settings/page.tsx" messages/
git commit -m "feat: add Mailpit settings card to environment settings"
```

---

### Task 8: Inbox server actions

**Files:**
- Create: `actions/mail.ts`
- Modify: `lib/validation.ts` (append mail input schemas)
- Modify: `app/[locale]/admin/activity/page.tsx` (three cases)
- Modify: `messages/{ar,en,es,id,zh}.json` (`activity.mailDeleted`, `activity.mailDeletedSearch`, `activity.mailCleared`)
- Test: `tests/validation.test.ts`

**Interfaces:**
- Consumes:
  - From Task 4: `listMailpitMessages`, `getMailpitMessage`, `getMailpitHeaders`, `getMailpitPart`, `getMailpitRaw`, `deleteMailpitMessages`, `deleteMailpitSearch`, `MailpitError`, `MailpitConfig`
  - From Task 5: `referencedCids`, `pickInlineParts`, `toDataUri`, `inlineCids`, `withPrelude`
  - `loadMailpitConfig` (Task 6), `environmentName` (Task 3)
- Produces:
  - From `@/lib/validation`: `mailpitIdSchema`, `mailpitPartIdSchema`, `mailListInputSchema`, `mailDeleteTargetSchema`, `type MailDeleteTarget`
  - From `@/actions/mail`:
    - `type MailResult<T> = { success: true; data: T } | { success: false; error: string; notFound?: boolean }`
    - `type MailDetail = { message: Omit<MailMessage, "HTML">; html: string | null; headers: Record<string, string[]> }`
    - `listMail(environmentId, input: { query?: string; start?: number }): Promise<MailResult<MessagesPage>>`
    - `getMail(environmentId, messageId): Promise<MailResult<MailDetail>>`
    - `getMailSource(environmentId, messageId): Promise<MailResult<{ source: string; truncated: boolean }>>`
    - `deleteMail(environmentId, target: MailDeleteTarget): Promise<MailResult<null>>`

- [ ] **Step 1: Write failing validation tests** (append to `tests/validation.test.ts`, extend the import list):

```ts
describe("mailpit ids", () => {
  it.each(["VjkzFzyhPMWm5kBoEygbAz", "0b8c6f5e-1d2a-4c1e-9f00-123456789abc"])(
    "accepts message id %p",
    (id) => {
      expect(mailpitIdSchema.safeParse(id).success).toBe(true);
    }
  );

  it.each(["", "../etc", "a/b", "x".repeat(65)])("rejects message id %p", (id) => {
    expect(mailpitIdSchema.safeParse(id).success).toBe(false);
  });

  it.each(["1", "1.2", "2.10.3"])("accepts part id %p", (id) => {
    expect(mailpitPartIdSchema.safeParse(id).success).toBe(true);
  });

  it.each(["", "1.", ".1", "1/2", "a"])("rejects part id %p", (id) => {
    expect(mailpitPartIdSchema.safeParse(id).success).toBe(false);
  });
});

describe("mailDeleteTargetSchema", () => {
  it("rejects an empty id selection (never means delete-all)", () => {
    expect(mailDeleteTargetSchema.safeParse({ scope: "ids", ids: [] }).success).toBe(false);
  });

  it("rejects a blank search", () => {
    expect(mailDeleteTargetSchema.safeParse({ scope: "search", query: "  " }).success).toBe(false);
  });

  it("accepts the three scopes", () => {
    expect(mailDeleteTargetSchema.safeParse({ scope: "ids", ids: ["abc"] }).success).toBe(true);
    expect(mailDeleteTargetSchema.safeParse({ scope: "search", query: "is:read" }).success).toBe(true);
    expect(mailDeleteTargetSchema.safeParse({ scope: "all" }).success).toBe(true);
  });
});

describe("mailListInputSchema", () => {
  it("defaults query and start", () => {
    expect(mailListInputSchema.parse({})).toEqual({ query: "", start: 0 });
  });

  it("rejects negative offsets", () => {
    expect(mailListInputSchema.safeParse({ start: -50 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/validation.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Append to `lib/validation.ts`**

```ts
// Mailpit message ids are short base62 tokens (older versions: UUIDs); part
// ids are dotted MIME paths ("1", "1.2"). Both end up in upstream URL paths.
export const mailpitIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const mailpitPartIdSchema = z
  .string()
  .max(32)
  .regex(/^\d+(?:\.\d+)*$/);

export const mailListInputSchema = z.object({
  query: z.string().trim().max(500).default(""),
  start: z.number().int().min(0).max(1_000_000).default(0),
});

// What an inbox delete targets. `ids` must be non-empty: Mailpit reads an
// empty id list as "delete everything", which only the explicit `all` scope
// may mean.
export const mailDeleteTargetSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("ids"),
    ids: z.array(mailpitIdSchema).min(1).max(500),
  }),
  z.object({
    scope: z.literal("search"),
    query: z.string().trim().min(1).max(500),
  }),
  z.object({ scope: z.literal("all") }),
]);
export type MailDeleteTarget = z.infer<typeof mailDeleteTargetSchema>;
```

- [ ] **Step 4: Create `actions/mail.ts`**

```ts
"use server";

import { recordActivity } from "@/lib/activity";
import { requireCapability } from "@/lib/auth-session";
import { environmentName } from "@/lib/environments";
import {
  deleteMailpitMessages,
  deleteMailpitSearch,
  getMailpitHeaders,
  getMailpitMessage,
  getMailpitPart,
  getMailpitRaw,
  listMailpitMessages,
  type MailpitConfig,
  MailpitError,
} from "@/lib/mailpit/client";
import { loadMailpitConfig } from "@/lib/mailpit/config";
import {
  inlineCids,
  pickInlineParts,
  referencedCids,
  toDataUri,
  withPrelude,
} from "@/lib/mailpit/html";
import type { MailMessage, MessagesPage } from "@/lib/mailpit/schemas";
import {
  mailDeleteTargetSchema,
  mailListInputSchema,
  mailpitIdSchema,
  uuidSchema,
} from "@/lib/validation";

export type MailResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; notFound?: boolean };

export type MailDetail = {
  message: Omit<MailMessage, "HTML">;
  // Prepared for <iframe srcdoc sandbox> (see lib/mailpit/html), or null.
  html: string | null;
  headers: Record<string, string[]>;
};

// The Raw tab is a preview; the full source is the .eml download.
const MAX_SOURCE_BYTES = 1024 * 1024;

type Fail = { success: false; error: string; notFound?: boolean };

// Validate + authorize + load config for one inbox action. The Mailpit URL and
// credentials come from the DB, never the client (SSRF).
async function requireMail(
  environmentId: string
): Promise<{ ok: true; cfg: MailpitConfig; userId: string } | { ok: false; fail: Fail }> {
  if (!uuidSchema.safeParse(environmentId).success) {
    return { ok: false, fail: { success: false, error: "Invalid environment id" } };
  }
  const session = await requireCapability("mail", { environmentId });
  const cfg = await loadMailpitConfig(environmentId);
  if (!cfg) {
    return {
      ok: false,
      fail: { success: false, error: "Mailpit is not configured for this environment" },
    };
  }
  return { ok: true, cfg, userId: session.user.id };
}

function failure(err: unknown): Fail {
  if (err instanceof MailpitError) {
    return { success: false, error: err.message, notFound: err.status === 404 };
  }
  console.error("Mailpit request failed:", err);
  return { success: false, error: "Mailpit request failed" };
}

export async function listMail(
  environmentId: string,
  input: unknown
): Promise<MailResult<MessagesPage>> {
  const auth = await requireMail(environmentId);
  if (!auth.ok) return auth.fail;
  const parsed = mailListInputSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid search" };
  try {
    return { success: true, data: await listMailpitMessages(auth.cfg, parsed.data) };
  } catch (err) {
    return failure(err);
  }
}

async function prepareHtml(
  cfg: MailpitConfig,
  message: MailMessage
): Promise<string | null> {
  if (!message.HTML) return null;
  const parts = pickInlineParts(message.Inline, referencedCids(message.HTML));
  const dataUris = new Map<string, string>();
  await Promise.all(
    parts.map(async (part) => {
      try {
        const res = await getMailpitPart(cfg, message.ID, part.PartID);
        const bytes = new Uint8Array(await res.arrayBuffer());
        dataUris.set(part.ContentID, toDataUri(part.ContentType, bytes));
      } catch {
        // A missing inline image renders broken; the message still opens.
      }
    })
  );
  return withPrelude(inlineCids(message.HTML, dataUris));
}

export async function getMail(
  environmentId: string,
  messageId: string
): Promise<MailResult<MailDetail>> {
  const auth = await requireMail(environmentId);
  if (!auth.ok) return auth.fail;
  if (!mailpitIdSchema.safeParse(messageId).success) {
    return { success: false, error: "Invalid message id" };
  }
  try {
    // Mailpit marks the message read on this GET — no separate call needed.
    const [message, headers] = await Promise.all([
      getMailpitMessage(auth.cfg, messageId),
      getMailpitHeaders(auth.cfg, messageId),
    ]);
    const { HTML: _html, ...rest } = message;
    return {
      success: true,
      data: { message: rest, html: await prepareHtml(auth.cfg, message), headers },
    };
  } catch (err) {
    return failure(err);
  }
}

export async function getMailSource(
  environmentId: string,
  messageId: string
): Promise<MailResult<{ source: string; truncated: boolean }>> {
  const auth = await requireMail(environmentId);
  if (!auth.ok) return auth.fail;
  if (!mailpitIdSchema.safeParse(messageId).success) {
    return { success: false, error: "Invalid message id" };
  }
  try {
    const res = await getMailpitRaw(auth.cfg, messageId);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const truncated = bytes.byteLength > MAX_SOURCE_BYTES;
    const source = new TextDecoder().decode(
      truncated ? bytes.subarray(0, MAX_SOURCE_BYTES) : bytes
    );
    return { success: true, data: { source, truncated } };
  } catch (err) {
    return failure(err);
  }
}

export async function deleteMail(
  environmentId: string,
  target: unknown
): Promise<MailResult<null>> {
  const auth = await requireMail(environmentId);
  if (!auth.ok) return auth.fail;
  const parsed = mailDeleteTargetSchema.safeParse(target);
  if (!parsed.success) return { success: false, error: "Invalid selection" };
  const t = parsed.data;
  try {
    if (t.scope === "ids") await deleteMailpitMessages(auth.cfg, t.ids);
    else if (t.scope === "search") await deleteMailpitSearch(auth.cfg, t.query);
    else await deleteMailpitMessages(auth.cfg, "all");
  } catch (err) {
    return failure(err);
  }

  const environment = (await environmentName(environmentId)) ?? environmentId;
  await recordActivity({
    actorId: auth.userId,
    action:
      t.scope === "ids"
        ? "mail.deleted"
        : t.scope === "search"
          ? "mail.deleted_search"
          : "mail.cleared",
    entityType: "environment",
    entityId: environmentId,
    data:
      t.scope === "ids"
        ? { environment, count: t.ids.length }
        : t.scope === "search"
          ? { environment, query: t.query }
          : { environment },
  });
  return { success: true, data: null };
}
```

- [ ] **Step 5: Activity rendering + strings**

In `app/[locale]/admin/activity/page.tsx`, add these cases next to the `mailpit.*` cases:

```ts
    case "mail.deleted":
      return t("mailDeleted", {
        actor,
        count: Number(d.count),
        environment: String(d.environment),
      });
    case "mail.deleted_search":
      return t("mailDeletedSearch", {
        actor,
        query: String(d.query),
        environment: String(d.environment),
      });
    case "mail.cleared":
      return t("mailCleared", { actor, environment: String(d.environment) });
```

Strings:

```bash
python3 - <<'PY'
import json
strings = {
  "en": {"mailDeleted": "{actor} deleted {count, plural, one {# email} other {# emails}} in {environment}", "mailDeletedSearch": "{actor} deleted emails matching “{query}” in {environment}", "mailCleared": "{actor} cleared the {environment} inbox"},
  "id": {"mailDeleted": "{actor} menghapus {count, plural, other {# email}} di {environment}", "mailDeletedSearch": "{actor} menghapus email yang cocok dengan “{query}” di {environment}", "mailCleared": "{actor} mengosongkan inbox {environment}"},
  "es": {"mailDeleted": "{actor} eliminó {count, plural, one {# correo} other {# correos}} en {environment}", "mailDeletedSearch": "{actor} eliminó los correos que coinciden con «{query}» en {environment}", "mailCleared": "{actor} vació la bandeja de {environment}"},
  "ar": {"mailDeleted": "حذف {actor} {count, plural, one {رسالة واحدة} other {# رسائل}} في {environment}", "mailDeletedSearch": "حذف {actor} الرسائل المطابقة لـ «{query}» في {environment}", "mailCleared": "أفرغ {actor} صندوق بريد {environment}"},
  "zh": {"mailDeleted": "{actor} 删除了 {environment} 中的 {count, plural, other {# 封邮件}}", "mailDeletedSearch": "{actor} 删除了 {environment} 中匹配“{query}”的邮件", "mailCleared": "{actor} 清空了 {environment} 的收件箱"},
}
for loc, add in strings.items():
    p = f"messages/{loc}.json"
    d = json.load(open(p, encoding="utf-8"))
    d["activity"].update(add)
    open(p, "w", encoding="utf-8").write(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
PY
```

- [ ] **Step 6: Run tests**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add actions/mail.ts lib/validation.ts tests/validation.test.ts "app/[locale]/admin/activity/page.tsx" messages/
git commit -m "feat: add inbox server actions for Mailpit"
```

---

### Task 9: Download routes (attachment part + raw .eml)

**Files:**
- Create: `lib/mailpit/download.ts` (pure response helpers, unit-tested)
- Create: `lib/mailpit/route.ts` (auth for route handlers; imports auth-session, so not unit-tested)
- Create: `app/api/environments/[environmentId]/mail/[messageId]/part/[partId]/route.ts`
- Create: `app/api/environments/[environmentId]/mail/[messageId]/raw/route.ts`
- Test: `tests/mailpit-route.test.ts`

**Interfaces:**
- Consumes:
  - From Task 4: `getMailpitMessage`, `getMailpitPart`, `getMailpitRaw`, `MailpitError`, `MailpitConfig`
  - `loadMailpitConfig` (Task 6)
  - `mailpitIdSchema`, `mailpitPartIdSchema` (Task 8)
- Produces:
  - `@/lib/mailpit/route`: `authorizeMailRoute(environmentId): Promise<{ ok: true; cfg: MailpitConfig } | { ok: false; response: Response }>`
  - `@/lib/mailpit/download`: `attachmentDisposition(filename: string): string`, `mailpitErrorResponse(err: unknown): Response`, `DOWNLOAD_HEADERS`

- [ ] **Step 1: Write failing test** — `tests/mailpit-route.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import { MailpitError } from "@/lib/mailpit/client";
import { attachmentDisposition, mailpitErrorResponse } from "@/lib/mailpit/download";

describe("attachmentDisposition", () => {
  it("is always an attachment with an RFC 5987 filename", () => {
    expect(attachmentDisposition("invoice.pdf")).toBe(
      "attachment; filename*=UTF-8''invoice.pdf"
    );
  });

  it("encodes non-ASCII and header-breaking characters", () => {
    expect(attachmentDisposition('fac"tura\r\nñ.pdf')).toBe(
      "attachment; filename*=UTF-8''fac%22tura%0D%0A%C3%B1.pdf"
    );
  });
});

describe("mailpitErrorResponse", () => {
  it("passes 404 through", () => {
    expect(mailpitErrorResponse(new MailpitError("gone", 404)).status).toBe(404);
  });

  it("maps other Mailpit failures to 502", async () => {
    const res = mailpitErrorResponse(new MailpitError("ECONNREFUSED"));
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("ECONNREFUSED");
  });

  it("hides unexpected errors behind 500", async () => {
    const res = mailpitErrorResponse(new Error("db password is hunter2"));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("hunter2");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/mailpit-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `lib/mailpit/download.ts`**

```ts
import { MailpitError } from "./client";

// Same encoding as the explorer download route. Always `attachment`: email
// parts are attacker-controlled, so they must never render on our origin.
export function attachmentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Forced octet-stream for the same reason: nothing from an email is ever
// sniffed or rendered as HTML/SVG by the browser.
export const DOWNLOAD_HEADERS = {
  "Content-Type": "application/octet-stream",
  "Cache-Control": "private, no-store",
} as const;

export function mailpitErrorResponse(err: unknown): Response {
  if (err instanceof MailpitError) {
    return new Response(err.message, { status: err.status === 404 ? 404 : 502 });
  }
  console.error("Mailpit download failed:", err);
  return new Response("Download failed", { status: 500 });
}
```

Create `lib/mailpit/route.ts`:

```ts
import "server-only";

import { getEffectiveRole, getServerSession } from "@/lib/auth-session";
import { roleHasCapability } from "@/lib/roles";
import { uuidSchema } from "@/lib/validation";
import type { MailpitConfig } from "./client";
import { loadMailpitConfig } from "./config";

// Route-handler twin of actions/mail#requireMail. Answers with a status code
// instead of redirecting: callers are downloads and EventSource, not pages.
export async function authorizeMailRoute(
  environmentId: string
): Promise<{ ok: true; cfg: MailpitConfig } | { ok: false; response: Response }> {
  if (!uuidSchema.safeParse(environmentId).success) {
    return { ok: false, response: new Response("Not found", { status: 404 }) };
  }
  const session = await getServerSession();
  if (!session) {
    return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  }
  // A session exists, so getEffectiveRole's requireSession cannot redirect.
  const role = await getEffectiveRole({ environmentId });
  if (!roleHasCapability(role, "mail")) {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }
  const cfg = await loadMailpitConfig(environmentId);
  if (!cfg) {
    return {
      ok: false,
      response: new Response("Mailpit is not configured", { status: 404 }),
    };
  }
  return { ok: true, cfg };
}
```

- [ ] **Step 4: Create the part route** — `app/api/environments/[environmentId]/mail/[messageId]/part/[partId]/route.ts`

```ts
import type { NextRequest } from "next/server";
import { getMailpitMessage, getMailpitPart } from "@/lib/mailpit/client";
import {
  attachmentDisposition,
  DOWNLOAD_HEADERS,
  mailpitErrorResponse,
} from "@/lib/mailpit/download";
import { authorizeMailRoute } from "@/lib/mailpit/route";
import { mailpitIdSchema, mailpitPartIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Streams one attachment/inline part of a captured email as a download.
export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ environmentId: string; messageId: string; partId: string }>;
  }
) {
  const { environmentId, messageId, partId } = await params;
  if (
    !mailpitIdSchema.safeParse(messageId).success ||
    !mailpitPartIdSchema.safeParse(partId).success
  ) {
    return new Response("Not found", { status: 404 });
  }
  const auth = await authorizeMailRoute(environmentId);
  if (!auth.ok) return auth.response;

  try {
    // Resolve the part from the message itself: a trusted filename, and part
    // ids the message doesn't declare are refused.
    const message = await getMailpitMessage(auth.cfg, messageId);
    const part = [...message.Attachments, ...message.Inline].find(
      (p) => p.PartID === partId
    );
    if (!part) return new Response("Not found", { status: 404 });

    const upstream = await getMailpitPart(auth.cfg, messageId, partId);
    return new Response(upstream.body, {
      headers: {
        ...DOWNLOAD_HEADERS,
        "Content-Disposition": attachmentDisposition(
          part.FileName || `part-${partId}`
        ),
      },
    });
  } catch (err) {
    return mailpitErrorResponse(err);
  }
}
```

- [ ] **Step 5: Create the raw route** — `app/api/environments/[environmentId]/mail/[messageId]/raw/route.ts`

```ts
import type { NextRequest } from "next/server";
import { getMailpitRaw } from "@/lib/mailpit/client";
import {
  attachmentDisposition,
  DOWNLOAD_HEADERS,
  mailpitErrorResponse,
} from "@/lib/mailpit/download";
import { authorizeMailRoute } from "@/lib/mailpit/route";
import { mailpitIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Downloads the full RFC 822 source of a captured email as `<id>.eml`.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ environmentId: string; messageId: string }> }
) {
  const { environmentId, messageId } = await params;
  if (!mailpitIdSchema.safeParse(messageId).success) {
    return new Response("Not found", { status: 404 });
  }
  const auth = await authorizeMailRoute(environmentId);
  if (!auth.ok) return auth.response;

  try {
    const upstream = await getMailpitRaw(auth.cfg, messageId);
    return new Response(upstream.body, {
      headers: {
        ...DOWNLOAD_HEADERS,
        "Content-Disposition": attachmentDisposition(`${messageId}.eml`),
      },
    });
  } catch (err) {
    return mailpitErrorResponse(err);
  }
}
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/mailpit-route.test.ts && bun run typecheck && bun run lint`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add lib/mailpit/download.ts lib/mailpit/route.ts "app/api/environments/[environmentId]/mail" tests/mailpit-route.test.ts
git commit -m "feat: stream Mailpit attachments and raw sources as downloads"
```

---

### Task 10: Realtime relay (Mailpit WebSocket → SSE)

**Files:**
- Create: `lib/mailpit/events.ts`
- Create: `app/api/environments/[environmentId]/mail/events/route.ts`
- Test: `tests/mailpit-events.test.ts`

**Interfaces:**
- Consumes:
  - `authorizeMailRoute` (Task 9)
  - `mailpitEventsUrl`, `mailpitAuthHeaders` (Task 4)
- Produces:
  - `mailEventType(raw: unknown): MailEventType | null`, where `type MailEventType = "new" | "update" | "delete" | "truncate" | "prune"`
  - SSE endpoint `GET /api/environments/{id}/mail/events`. It emits:
    - a `retry: 10000` frame first
    - `event: ready` once the upstream WebSocket opens
    - `event: mail` with `{ type }`
    - `event: stream-error` with `{ message }`
    - `event: timeout`

- [ ] **Step 1: Write failing test** — `tests/mailpit-events.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import { mailEventType } from "@/lib/mailpit/events";

describe("mailEventType", () => {
  it.each(["new", "update", "delete", "truncate", "prune"])(
    "relays %s frames",
    (type) => {
      expect(mailEventType(JSON.stringify({ Type: type, Data: {} }))).toBe(type);
    }
  );

  it.each([
    JSON.stringify({ Type: "stats", Data: { Total: 3 } }),
    JSON.stringify({ Type: "error", Data: {} }),
    "not json",
    JSON.stringify({ nope: 1 }),
  ])("ignores %s", (raw) => {
    expect(mailEventType(raw)).toBeNull();
  });

  it("ignores binary frames", () => {
    expect(mailEventType(new ArrayBuffer(4))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/mailpit-events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `lib/mailpit/events.ts`**

```ts
// Mailpit's /api/events WebSocket sends `{ Type, Data }` frames. Only the ones
// that change what the inbox list shows are relayed; `stats` (counter ticks)
// and `error` frames are dropped.
const LIST_EVENTS = ["new", "update", "delete", "truncate", "prune"] as const;
export type MailEventType = (typeof LIST_EVENTS)[number];

export function mailEventType(raw: unknown): MailEventType | null {
  if (typeof raw !== "string") return null;
  try {
    const type = (JSON.parse(raw) as { Type?: unknown }).Type;
    return LIST_EVENTS.includes(type as MailEventType)
      ? (type as MailEventType)
      : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Create the SSE route** — `app/api/environments/[environmentId]/mail/events/route.ts`

```ts
import type { NextRequest } from "next/server";
import { mailpitAuthHeaders, mailpitEventsUrl } from "@/lib/mailpit/client";
import { mailEventType } from "@/lib/mailpit/events";
import { authorizeMailRoute } from "@/lib/mailpit/route";

// Relays the environment's Mailpit /api/events WebSocket to the browser as
// SSE, so the inbox refreshes when mail arrives. Same shape as the log stream
// route: capped duration + heartbeat, and EventSource reconnects on close.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DURATION_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
// Reconnect delay the browser uses after a drop — keeps a down Mailpit from
// being hammered by every open inbox tab.
const RETRY_MS = 10_000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ environmentId: string }> }
) {
  const { environmentId } = await params;
  const auth = await authorizeMailRoute(environmentId);
  if (!auth.ok) return auth.response;
  const { cfg } = auth;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let socket: WebSocket | null = null;

      function enqueue(payload: string) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      }

      function send(event: string, data: unknown) {
        enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }

      const heartbeat = setInterval(
        () => enqueue(": ping\n\n"),
        HEARTBEAT_INTERVAL_MS
      );
      const maxDuration = setTimeout(() => {
        send("timeout", { reason: "max-duration" });
        tearDown();
      }, MAX_DURATION_MS);

      function tearDown() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(maxDuration);
        try {
          socket?.close();
        } catch {
          // already closed
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      }

      req.signal.addEventListener("abort", tearDown);
      enqueue(`retry: ${RETRY_MS}\n\n`);

      try {
        // Bun and Node (undici) both accept a non-standard `headers` init —
        // the only way to send Basic Auth on the upgrade request.
        socket = new WebSocket(mailpitEventsUrl(cfg.url), {
          headers: mailpitAuthHeaders(cfg),
        } as unknown as string[]);
      } catch (err) {
        send("stream-error", {
          message: err instanceof Error ? err.message : "Failed to connect",
        });
        tearDown();
        return;
      }

      socket.addEventListener("open", () => send("ready", {}));
      socket.addEventListener("message", (event) => {
        const type = mailEventType(event.data);
        if (type) send("mail", { type });
      });
      socket.addEventListener("error", () => {
        send("stream-error", { message: "Mailpit event stream failed" });
        tearDown();
      });
      socket.addEventListener("close", tearDown);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/mailpit-events.test.ts && bun run typecheck && bun run lint`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add lib/mailpit/events.ts "app/api/environments/[environmentId]/mail/events" tests/mailpit-events.test.ts
git commit -m "feat: relay Mailpit events to the inbox over SSE"
```

---

### Task 11: Inbox page, sidebar entry, breadcrumbs

**Files:**
- Create: `app/[locale]/[projectKey]/[envSlug]/mail/page.tsx`
- Create: `app/[locale]/[projectKey]/[envSlug]/mail/loading.tsx`
- Create: `app/[locale]/[projectKey]/[envSlug]/mail/mail-inbox.tsx`
- Create: `app/[locale]/[projectKey]/[envSlug]/mail/mail-list.tsx`
- Create: `app/[locale]/[projectKey]/[envSlug]/mail/mail-detail.tsx`
- Modify: `components/app-sidebar.tsx` (projectItems + filter + icon import)
- Modify: `components/header-breadcrumb.tsx` (`PARALLEL_SECTIONS`, `getEnvironmentSubKey`)
- Modify: `messages/{ar,en,es,id,zh}.json` (`nav.mail`, `breadcrumbs.mail`, `mail` namespace)

**Interfaces:**
- Consumes:
  - From Task 8: `listMail`, `getMail`, `getMailSource`, `deleteMail`, `MailResult`, `MailDetail`
  - `MailDeleteTarget` (Task 8, `@/lib/validation`)
  - `MAIL_PAGE_SIZE`, `MessagesPage`, `MailAddress` (Task 4)
  - `loadMailpitConfig` (Task 6), `hasMailpit` (Task 3)
  - The SSE endpoint (Task 10) and download routes (Task 9)
- Produces: the `/[projectKey]/[envSlug]/mail` page.

- [ ] **Step 1: i18n**

```bash
python3 - <<'PY'
import json
nav = {"en": "Mail", "id": "Email", "es": "Correo", "ar": "البريد", "zh": "邮件"}
mail = {
  "en": {"title": "Mail", "subtitle": "Email captured by Mailpit for {name}.", "searchPlaceholder": "Search (e.g. to:user@example.com subject:reset is:unread)", "refresh": "Refresh", "live": "Live", "offline": "Reconnecting…", "loading": "Loading…", "empty": "No messages", "emptySearch": "No messages match this search", "selectPrompt": "Select a message to read it", "notConfiguredTitle": "Mailpit is not connected", "notConfiguredDescription": "An admin can connect this environment's Mailpit in settings.", "openSettings": "Open settings", "forbiddenTitle": "Mail is restricted", "forbiddenDescription": "Reading captured email requires the member role or higher on this project.", "loadFailed": "Could not load mail", "retry": "Retry", "from": "From", "to": "To", "cc": "Cc", "date": "Date", "noSubject": "(no subject)", "tabHtml": "HTML", "tabText": "Text", "tabHeaders": "Headers", "tabRaw": "Raw", "noHtml": "This message has no HTML part.", "noText": "This message has no text part.", "sourceTruncated": "Showing the first 1 MB. Download the .eml for the full source.", "attachments": "Attachments", "downloadEml": "Download .eml", "messageGone": "This message no longer exists.", "delete": "Delete", "deleteSelected": "Delete selected ({count})", "deleteAll": "Delete all", "deleteMatching": "Delete all matching", "deleteConfirmTitle": "Delete messages?", "deleteSelectedConfirm": "{count, plural, one {# message} other {# messages}} will be permanently deleted from Mailpit.", "deleteAllConfirm": "Every message in this environment's Mailpit will be permanently deleted.", "deleteMatchingConfirm": "Every message matching “{query}” will be permanently deleted.", "deleted": "Deleted", "total": "{count, plural, one {# message} other {# messages}}", "previous": "Previous", "next": "Next", "selectAll": "Select all on this page"},
  "id": {"title": "Email", "subtitle": "Email yang ditangkap Mailpit untuk {name}.", "searchPlaceholder": "Cari (mis. to:user@example.com subject:reset is:unread)", "refresh": "Muat ulang", "live": "Live", "offline": "Menyambung ulang…", "loading": "Memuat…", "empty": "Tidak ada pesan", "emptySearch": "Tidak ada pesan yang cocok", "selectPrompt": "Pilih pesan untuk membacanya", "notConfiguredTitle": "Mailpit belum terhubung", "notConfiguredDescription": "Admin dapat menghubungkan Mailpit environment ini di pengaturan.", "openSettings": "Buka pengaturan", "forbiddenTitle": "Email dibatasi", "forbiddenDescription": "Membaca email yang ditangkap memerlukan role member atau lebih tinggi di project ini.", "loadFailed": "Gagal memuat email", "retry": "Coba lagi", "from": "Dari", "to": "Kepada", "cc": "Cc", "date": "Tanggal", "noSubject": "(tanpa subjek)", "tabHtml": "HTML", "tabText": "Teks", "tabHeaders": "Header", "tabRaw": "Raw", "noHtml": "Pesan ini tidak punya bagian HTML.", "noText": "Pesan ini tidak punya bagian teks.", "sourceTruncated": "Menampilkan 1 MB pertama. Unduh .eml untuk source lengkap.", "attachments": "Lampiran", "downloadEml": "Unduh .eml", "messageGone": "Pesan ini sudah tidak ada.", "delete": "Hapus", "deleteSelected": "Hapus terpilih ({count})", "deleteAll": "Hapus semua", "deleteMatching": "Hapus semua yang cocok", "deleteConfirmTitle": "Hapus pesan?", "deleteSelectedConfirm": "{count, plural, other {# pesan}} akan dihapus permanen dari Mailpit.", "deleteAllConfirm": "Semua pesan di Mailpit environment ini akan dihapus permanen.", "deleteMatchingConfirm": "Semua pesan yang cocok dengan “{query}” akan dihapus permanen.", "deleted": "Terhapus", "total": "{count, plural, other {# pesan}}", "previous": "Sebelumnya", "next": "Berikutnya", "selectAll": "Pilih semua di halaman ini"},
  "es": {"title": "Correo", "subtitle": "Correo capturado por Mailpit para {name}.", "searchPlaceholder": "Buscar (p. ej. to:user@example.com subject:reset is:unread)", "refresh": "Actualizar", "live": "En vivo", "offline": "Reconectando…", "loading": "Cargando…", "empty": "No hay mensajes", "emptySearch": "Ningún mensaje coincide con la búsqueda", "selectPrompt": "Selecciona un mensaje para leerlo", "notConfiguredTitle": "Mailpit no está conectado", "notConfiguredDescription": "Un administrador puede conectar el Mailpit de este entorno en la configuración.", "openSettings": "Abrir configuración", "forbiddenTitle": "El correo está restringido", "forbiddenDescription": "Leer el correo capturado requiere el rol de miembro o superior en este proyecto.", "loadFailed": "No se pudo cargar el correo", "retry": "Reintentar", "from": "De", "to": "Para", "cc": "Cc", "date": "Fecha", "noSubject": "(sin asunto)", "tabHtml": "HTML", "tabText": "Texto", "tabHeaders": "Cabeceras", "tabRaw": "Original", "noHtml": "Este mensaje no tiene parte HTML.", "noText": "Este mensaje no tiene parte de texto.", "sourceTruncated": "Se muestra el primer MB. Descarga el .eml para ver el original completo.", "attachments": "Adjuntos", "downloadEml": "Descargar .eml", "messageGone": "Este mensaje ya no existe.", "delete": "Eliminar", "deleteSelected": "Eliminar seleccionados ({count})", "deleteAll": "Eliminar todo", "deleteMatching": "Eliminar coincidencias", "deleteConfirmTitle": "¿Eliminar mensajes?", "deleteSelectedConfirm": "{count, plural, one {# mensaje se eliminará} other {# mensajes se eliminarán}} de Mailpit de forma permanente.", "deleteAllConfirm": "Se eliminarán de forma permanente todos los mensajes del Mailpit de este entorno.", "deleteMatchingConfirm": "Se eliminarán de forma permanente todos los mensajes que coincidan con «{query}».", "deleted": "Eliminado", "total": "{count, plural, one {# mensaje} other {# mensajes}}", "previous": "Anterior", "next": "Siguiente", "selectAll": "Seleccionar todo en esta página"},
  "ar": {"title": "البريد", "subtitle": "البريد الذي التقطه Mailpit للبيئة {name}.", "searchPlaceholder": "بحث (مثل to:user@example.com subject:reset is:unread)", "refresh": "تحديث", "live": "مباشر", "offline": "جارٍ إعادة الاتصال…", "loading": "جارٍ التحميل…", "empty": "لا توجد رسائل", "emptySearch": "لا توجد رسائل مطابقة لهذا البحث", "selectPrompt": "اختر رسالة لقراءتها", "notConfiguredTitle": "Mailpit غير متصل", "notConfiguredDescription": "يمكن للمسؤول ربط Mailpit لهذه البيئة من الإعدادات.", "openSettings": "فتح الإعدادات", "forbiddenTitle": "البريد مقيّد", "forbiddenDescription": "تتطلب قراءة البريد الملتقط دور عضو أو أعلى في هذا المشروع.", "loadFailed": "تعذّر تحميل البريد", "retry": "إعادة المحاولة", "from": "من", "to": "إلى", "cc": "نسخة", "date": "التاريخ", "noSubject": "(بدون موضوع)", "tabHtml": "HTML", "tabText": "نص", "tabHeaders": "الترويسات", "tabRaw": "المصدر", "noHtml": "لا تحتوي هذه الرسالة على جزء HTML.", "noText": "لا تحتوي هذه الرسالة على جزء نصي.", "sourceTruncated": "يُعرض أول 1 ميغابايت فقط. نزّل ملف ‎.eml للحصول على المصدر الكامل.", "attachments": "المرفقات", "downloadEml": "تنزيل ‎.eml", "messageGone": "هذه الرسالة لم تعد موجودة.", "delete": "حذف", "deleteSelected": "حذف المحدد ({count})", "deleteAll": "حذف الكل", "deleteMatching": "حذف كل المطابق", "deleteConfirmTitle": "حذف الرسائل؟", "deleteSelectedConfirm": "سيتم حذف {count, plural, one {رسالة واحدة} other {# رسائل}} نهائيًا من Mailpit.", "deleteAllConfirm": "سيتم حذف كل الرسائل في Mailpit لهذه البيئة نهائيًا.", "deleteMatchingConfirm": "سيتم حذف كل الرسائل المطابقة لـ «{query}» نهائيًا.", "deleted": "تم الحذف", "total": "{count, plural, one {رسالة واحدة} other {# رسائل}}", "previous": "السابق", "next": "التالي", "selectAll": "تحديد الكل في هذه الصفحة"},
  "zh": {"title": "邮件", "subtitle": "Mailpit 为 {name} 捕获的邮件。", "searchPlaceholder": "搜索（如 to:user@example.com subject:reset is:unread）", "refresh": "刷新", "live": "实时", "offline": "正在重新连接…", "loading": "加载中…", "empty": "没有邮件", "emptySearch": "没有匹配此搜索的邮件", "selectPrompt": "选择一封邮件进行阅读", "notConfiguredTitle": "未连接 Mailpit", "notConfiguredDescription": "管理员可以在设置中为此环境连接 Mailpit。", "openSettings": "打开设置", "forbiddenTitle": "邮件受限", "forbiddenDescription": "阅读捕获的邮件需要此项目的成员或更高角色。", "loadFailed": "无法加载邮件", "retry": "重试", "from": "发件人", "to": "收件人", "cc": "抄送", "date": "日期", "noSubject": "（无主题）", "tabHtml": "HTML", "tabText": "文本", "tabHeaders": "邮件头", "tabRaw": "原文", "noHtml": "此邮件没有 HTML 部分。", "noText": "此邮件没有文本部分。", "sourceTruncated": "仅显示前 1 MB。下载 .eml 查看完整原文。", "attachments": "附件", "downloadEml": "下载 .eml", "messageGone": "此邮件已不存在。", "delete": "删除", "deleteSelected": "删除所选（{count}）", "deleteAll": "全部删除", "deleteMatching": "删除所有匹配项", "deleteConfirmTitle": "删除邮件？", "deleteSelectedConfirm": "{count, plural, other {# 封邮件}}将从 Mailpit 中永久删除。", "deleteAllConfirm": "此环境 Mailpit 中的所有邮件都将被永久删除。", "deleteMatchingConfirm": "所有匹配“{query}”的邮件都将被永久删除。", "deleted": "已删除", "total": "{count, plural, other {# 封邮件}}", "previous": "上一页", "next": "下一页", "selectAll": "全选本页"},
}
for loc in nav:
    p = f"messages/{loc}.json"
    d = json.load(open(p, encoding="utf-8"))
    d["nav"]["mail"] = nav[loc]
    d["breadcrumbs"]["mail"] = nav[loc]
    d["mail"] = mail[loc]
    open(p, "w", encoding="utf-8").write(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
PY
```

- [ ] **Step 2: Sidebar + breadcrumbs**

`components/app-sidebar.tsx`:
- Add `Mail` to the `lucide-react` import (alphabetical, after `LayoutDashboard`).
- Insert this into `projectItems` after `mockTime`:
  ```ts
  { key: "mail", url: "/mail", icon: Mail, adminOnly: false },
  ```
- Change the filter in the env group to:
  ```ts
  {projectItems
    .filter((item) => !item.adminOnly || isAdmin)
    // Mail only exists once a Mailpit is connected. Role gating happens on
    // the page: the sidebar knows only the global role, not membership.
    .filter((item) => item.key !== "mail" || activeEnv.hasMailpit)
  ```

`components/header-breadcrumb.tsx`:
- Add `"mail"` to `PARALLEL_SECTIONS`.
- Add `case "mail": return "breadcrumbs.mail";` to `getEnvironmentSubKey`.

- [ ] **Step 3: Page** — `app/[locale]/[projectKey]/[envSlug]/mail/page.tsx`

```tsx
import { Lock, Mail } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getEnvironmentById } from "@/actions/environments";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { getEffectiveRole, isAdmin, requireSession } from "@/lib/auth-session";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import { loadMailpitConfig } from "@/lib/mailpit/config";
import { roleHasCapability } from "@/lib/roles";
import { MailInbox } from "./mail-inbox";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}) {
  const { locale, projectKey, envSlug } = await params;
  const environmentId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  setRequestLocale(locale);

  const [session, environment, role] = await Promise.all([
    requireSession(),
    getEnvironmentById(environmentId),
    getEffectiveRole({ environmentId }),
  ]);
  const t = await getTranslations("mail");
  const tCommon = await getTranslations("common");

  if (!environment) return <p>{tCommon("environmentNotFound")}</p>;

  const header = (
    <PageHeader
      title={t("title")}
      subtitle={t("subtitle", { name: environment.name })}
    />
  );

  if (!roleHasCapability(role, "mail")) {
    return (
      <>
        {header}
        <EmptyState
          icon={Lock}
          title={t("forbiddenTitle")}
          description={t("forbiddenDescription")}
        />
      </>
    );
  }

  if (!(await loadMailpitConfig(environmentId))) {
    return (
      <>
        {header}
        <EmptyState
          icon={Mail}
          title={t("notConfiguredTitle")}
          description={t("notConfiguredDescription")}
          action={
            isAdmin(session) ? (
              <Button
                render={<Link href={`/${projectKey}/${envSlug}/settings`} />}
                variant="outline"
              >
                {t("openSettings")}
              </Button>
            ) : undefined
          }
        />
      </>
    );
  }

  return (
    <>
      {header}
      <MailInbox environmentId={environmentId} />
    </>
  );
}
```

- [ ] **Step 4: Loading skeleton** — `app/[locale]/[projectKey]/[envSlug]/mail/loading.tsx`

```tsx
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(320px,2fr)_3fr]">
        <div className="flex flex-col gap-3 rounded-lg border p-3">
          {Array.from({ length: 8 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
            <div key={i} className="flex flex-col gap-1">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
        <Skeleton className="min-h-[60vh] rounded-lg" />
      </div>
    </>
  );
}
```

- [ ] **Step 5: Inbox container** — `app/[locale]/[projectKey]/[envSlug]/mail/mail-inbox.tsx`

```tsx
"use client";

import { RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import { deleteMail, listMail } from "@/actions/mail";
import { useDialog } from "@/components/dialog-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MessagesPage } from "@/lib/mailpit/schemas";
import { cn } from "@/lib/utils";
import type { MailDeleteTarget } from "@/lib/validation";
import { MailDetailPane } from "./mail-detail";
import { MailList } from "./mail-list";

// Debounce realtime bursts (a test suite sending 20 mails) into one refetch.
const REFRESH_DEBOUNCE_MS = 500;

export function MailInbox({ environmentId }: { environmentId: string }) {
  const t = useTranslations("mail");
  const tCommon = useTranslations("common");
  const dialog = useDialog();

  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [start, setStart] = useState(0);
  const [page, setPage] = useState<MessagesPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [live, setLive] = useState(false);
  const [loading, startLoading] = useTransition();
  const [deleting, startDeleting] = useTransition();

  const load = useCallback(() => {
    startLoading(async () => {
      const result = await listMail(environmentId, { query, start });
      if (!result.success) {
        setError(result.error);
        return;
      }
      setError(null);
      setPage(result.data);
      // Drop selections that scrolled off or were deleted elsewhere.
      const ids = new Set(result.data.messages.map((m) => m.ID));
      setChecked((prev) => new Set([...prev].filter((id) => ids.has(id))));
    });
  }, [environmentId, query, start]);

  useEffect(() => {
    load();
  }, [load]);

  const onMailEvent = useEffectEvent(() => load());

  useEffect(() => {
    const source = new EventSource(
      `/api/environments/${environmentId}/mail/events`
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("ready", () => setLive(true));
    source.addEventListener("mail", () => {
      clearTimeout(timer);
      timer = setTimeout(onMailEvent, REFRESH_DEBOUNCE_MS);
    });
    source.onerror = () => setLive(false);
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [environmentId]);

  async function confirmDelete(target: MailDeleteTarget, description: string) {
    const ok = await dialog.confirm({
      title: t("deleteConfirmTitle"),
      description,
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (!ok) return;
    startDeleting(async () => {
      const result = await deleteMail(environmentId, target);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(t("deleted"));
      if (
        target.scope !== "ids" ||
        (selectedId !== null && target.ids.includes(selectedId))
      ) {
        setSelectedId(null);
      }
      setChecked(new Set());
      load();
    });
  }

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    setStart(0);
    setSelectedId(null);
    setQuery(queryInput.trim());
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <form className="min-w-64 flex-1" onSubmit={onSearch}>
          <Input
            type="search"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
          />
        </form>
        <span
          className={cn(
            "flex items-center gap-1.5 text-xs",
            live ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
          )}
        >
          <span
            className={cn(
              "size-2 rounded-full",
              live ? "bg-emerald-500" : "bg-muted-foreground/50"
            )}
            aria-hidden
          />
          {live ? t("live") : t("offline")}
        </span>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          {t("refresh")}
        </Button>
        {checked.size > 0 && (
          <Button
            variant="destructive"
            size="sm"
            disabled={deleting}
            onClick={() =>
              confirmDelete(
                { scope: "ids", ids: [...checked] },
                t("deleteSelectedConfirm", { count: checked.size })
              )
            }
          >
            <Trash2 className="size-4" />
            {t("deleteSelected", { count: checked.size })}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={deleting || !page?.messages_count}
          onClick={() =>
            query
              ? confirmDelete(
                  { scope: "search", query },
                  t("deleteMatchingConfirm", { query })
                )
              : confirmDelete({ scope: "all" }, t("deleteAllConfirm"))
          }
        >
          <Trash2 className="size-4" />
          {query ? t("deleteMatching") : t("deleteAll")}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>{t("loadFailed")}</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-2">
            <span className="break-all">{error}</span>
            <Button size="sm" variant="outline" onClick={load}>
              {t("retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid min-h-[60vh] gap-4 lg:grid-cols-[minmax(320px,2fr)_3fr]">
        <MailList
          page={page}
          query={query}
          start={start}
          selectedId={selectedId}
          checked={checked}
          onSelect={setSelectedId}
          onCheckedChange={setChecked}
          onPageChange={setStart}
        />
        <MailDetailPane
          environmentId={environmentId}
          messageId={selectedId}
          onDelete={(id) =>
            confirmDelete(
              { scope: "ids", ids: [id] },
              t("deleteSelectedConfirm", { count: 1 })
            )
          }
          onGone={load}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: List** — `app/[locale]/[projectKey]/[envSlug]/mail/mail-list.tsx`

```tsx
"use client";

import { Paperclip } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { MAIL_PAGE_SIZE, type MessagesPage } from "@/lib/mailpit/schemas";
import { cn } from "@/lib/utils";

export function MailList({
  page,
  query,
  start,
  selectedId,
  checked,
  onSelect,
  onCheckedChange,
  onPageChange,
}: {
  page: MessagesPage | null;
  query: string;
  start: number;
  selectedId: string | null;
  checked: Set<string>;
  onSelect: (id: string) => void;
  onCheckedChange: (next: Set<string>) => void;
  onPageChange: (start: number) => void;
}) {
  const t = useTranslations("mail");
  const format = useFormatter();

  if (!page) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border p-3">
        <span className="sr-only">{t("loading")}</span>
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
          <div key={i} className="flex flex-col gap-1">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </div>
    );
  }

  const ids = page.messages.map((m) => m.ID);
  const allChecked = ids.length > 0 && ids.every((id) => checked.has(id));

  function toggle(id: string, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(id);
    else next.delete(id);
    onCheckedChange(next);
  }

  function toggleAll(on: boolean) {
    onCheckedChange(
      on
        ? new Set([...checked, ...ids])
        : new Set([...checked].filter((id) => !ids.includes(id)))
    );
  }

  return (
    <div className="flex min-h-0 flex-col rounded-lg border">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <Checkbox
          checked={allChecked}
          onCheckedChange={(on) => toggleAll(on)}
          disabled={ids.length === 0}
          aria-label={t("selectAll")}
        />
        <span>{t("total", { count: page.messages_count })}</span>
      </div>

      {page.messages.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">
          {query ? t("emptySearch") : t("empty")}
        </p>
      ) : (
        <ul className="flex-1 divide-y overflow-y-auto">
          {page.messages.map((m) => (
            <li
              key={m.ID}
              className={cn(
                "flex gap-2 px-3 py-2",
                m.ID === selectedId && "bg-muted"
              )}
            >
              <Checkbox
                className="mt-1"
                checked={checked.has(m.ID)}
                onCheckedChange={(on) => toggle(m.ID, on)}
                aria-label={m.Subject || t("noSubject")}
              />
              <button
                type="button"
                className="min-w-0 flex-1 text-start"
                onClick={() => onSelect(m.ID)}
              >
                <div className="flex items-center gap-2">
                  {!m.Read && (
                    <span
                      className="size-2 shrink-0 rounded-full bg-primary"
                      aria-hidden
                    />
                  )}
                  <span
                    className={cn("truncate text-sm", !m.Read && "font-semibold")}
                  >
                    {m.From?.Name || m.From?.Address || "—"}
                  </span>
                  <time
                    className="ms-auto shrink-0 text-xs text-muted-foreground"
                    dateTime={m.Created}
                  >
                    {format.relativeTime(new Date(m.Created))}
                  </time>
                </div>
                <div className="flex items-center gap-1">
                  <span className="truncate text-sm">
                    {m.Subject || t("noSubject")}
                  </span>
                  {m.Attachments > 0 && (
                    <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {m.Snippet}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between border-t px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={start === 0}
          onClick={() => onPageChange(Math.max(0, start - MAIL_PAGE_SIZE))}
        >
          {t("previous")}
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">
          {page.messages.length === 0 ? 0 : start + 1}–
          {start + page.messages.length}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={start + MAIL_PAGE_SIZE >= page.messages_count}
          onClick={() => onPageChange(start + MAIL_PAGE_SIZE)}
        >
          {t("next")}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Detail pane** — `app/[locale]/[projectKey]/[envSlug]/mail/mail-detail.tsx`

```tsx
"use client";

import { Download, Paperclip, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useEffectEvent, useState, useTransition } from "react";
import {
  getMail,
  getMailSource,
  type MailDetail,
  type MailResult,
} from "@/actions/mail";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MailAddress } from "@/lib/mailpit/schemas";
import { formatBytes } from "@/lib/utils";

function formatAddresses(list: MailAddress[]): string {
  return list
    .map((a) => (a.Name ? `${a.Name} <${a.Address}>` : a.Address))
    .join(", ");
}

function Pane({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col rounded-lg border">
      {children}
    </div>
  );
}

export function MailDetailPane({
  environmentId,
  messageId,
  onDelete,
  onGone,
}: {
  environmentId: string;
  messageId: string | null;
  onDelete: (id: string) => void;
  onGone: () => void;
}) {
  const t = useTranslations("mail");
  const format = useFormatter();
  const [detail, setDetail] = useState<{
    id: string;
    result: MailResult<MailDetail>;
  } | null>(null);
  const [source, setSource] = useState<{
    id: string;
    result: MailResult<{ source: string; truncated: boolean }>;
  } | null>(null);
  const [loading, startLoading] = useTransition();
  const notifyGone = useEffectEvent(onGone);

  useEffect(() => {
    if (!messageId) return;
    startLoading(async () => {
      const result = await getMail(environmentId, messageId);
      setDetail({ id: messageId, result });
      // Opening marks it read upstream; a 404 means it was deleted elsewhere.
      if (!result.success && result.notFound) notifyGone();
    });
  }, [environmentId, messageId]);

  function loadSource(id: string) {
    if (source?.id === id) return;
    startLoading(async () => {
      setSource({ id, result: await getMailSource(environmentId, id) });
    });
  }

  if (!messageId) {
    return (
      <Pane>
        <p className="m-auto p-6 text-sm text-muted-foreground">
          {t("selectPrompt")}
        </p>
      </Pane>
    );
  }

  if (!detail || detail.id !== messageId) {
    return (
      <Pane>
        <div className="flex flex-col gap-2 p-4">
          <span className="sr-only">{t("loading")}</span>
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-4 h-[50vh] w-full" />
        </div>
      </Pane>
    );
  }

  if (!detail.result.success) {
    return (
      <Pane>
        <p className="m-auto p-6 text-sm text-muted-foreground">
          {detail.result.notFound ? t("messageGone") : detail.result.error}
        </p>
      </Pane>
    );
  }

  const { message, html, headers } = detail.result.data;
  const base = `/api/environments/${environmentId}/mail/${message.ID}`;
  const files = [...message.Attachments];

  return (
    <Pane>
      <div className="flex items-start gap-2 border-b p-4">
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="break-words text-base font-semibold">
            {message.Subject || t("noSubject")}
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">{t("from")}</dt>
            <dd className="break-all">
              {formatAddresses(message.From ? [message.From] : [])}
            </dd>
            <dt className="text-muted-foreground">{t("to")}</dt>
            <dd className="break-all">{formatAddresses(message.To)}</dd>
            {message.Cc.length > 0 && (
              <>
                <dt className="text-muted-foreground">{t("cc")}</dt>
                <dd className="break-all">{formatAddresses(message.Cc)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{t("date")}</dt>
            <dd>
              {format.dateTime(new Date(message.Date), {
                dateStyle: "medium",
                timeStyle: "medium",
              })}
            </dd>
          </dl>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={<a href={`${base}/raw`} download />}
        >
          <Download className="size-4" />
          {t("downloadEml")}
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onDelete(message.ID)}
          aria-label={t("delete")}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {files.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
          <span className="text-muted-foreground">{t("attachments")}</span>
          {files.map((file) => (
            <a
              key={file.PartID}
              href={`${base}/part/${encodeURIComponent(file.PartID)}`}
              download
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted"
            >
              <Paperclip className="size-3" />
              <span className="max-w-48 truncate">
                {file.FileName || file.PartID}
              </span>
              <span className="text-muted-foreground">
                {formatBytes(file.Size)}
              </span>
            </a>
          ))}
        </div>
      )}

      <Tabs
        key={message.ID}
        defaultValue={html ? "html" : "text"}
        className="min-h-0 flex-1 p-4"
        onValueChange={(value) => {
          if (value === "raw") loadSource(message.ID);
        }}
      >
        <TabsList>
          <TabsTrigger value="html">{t("tabHtml")}</TabsTrigger>
          <TabsTrigger value="text">{t("tabText")}</TabsTrigger>
          <TabsTrigger value="headers">{t("tabHeaders")}</TabsTrigger>
          <TabsTrigger value="raw">{t("tabRaw")}</TabsTrigger>
        </TabsList>

        <TabsContent value="html">
          {html ? (
            // srcdoc, not src: the app sends frame-ancestors 'none'. No
            // allow-scripts / allow-same-origin — the email can't run code or
            // touch OpsDeck; popups let QA follow reset/verify links.
            <iframe
              title={message.Subject || t("noSubject")}
              srcDoc={html}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              className="h-[60vh] w-full rounded-md border bg-white"
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t("noHtml")}</p>
          )}
        </TabsContent>

        <TabsContent value="text">
          {message.Text ? (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-sm">
              {message.Text}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noText")}</p>
          )}
        </TabsContent>

        <TabsContent value="headers">
          <dl className="max-h-[60vh] overflow-auto text-xs">
            {Object.entries(headers).flatMap(([name, values]) =>
              values.map((value, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: repeated headers share a name
                  key={`${name}-${i}`}
                  className="grid grid-cols-[minmax(8rem,12rem)_1fr] gap-2 border-b py-1 font-mono"
                >
                  <dt className="text-muted-foreground">{name}</dt>
                  <dd className="break-all">{value}</dd>
                </div>
              ))
            )}
          </dl>
        </TabsContent>

        <TabsContent value="raw">
          {source?.id !== message.ID || loading ? (
            <Skeleton className="h-[50vh] w-full" />
          ) : source.result.success ? (
            <>
              {source.result.data.truncated && (
                <p className="mb-2 text-xs text-muted-foreground">
                  {t("sourceTruncated")}
                </p>
              )}
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
                {source.result.data.source}
              </pre>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {source.result.error}
            </p>
          )}
        </TabsContent>
      </Tabs>
    </Pane>
  );
}
```

- [ ] **Step 8: Verify**

Run: `bun run typecheck && bun run lint && bun test`
Expected: clean. If Biome flags `useExhaustiveDependencies` on the effects that call `useEffectEvent` callbacks, the effect-event functions are deliberately excluded. Add `// biome-ignore lint/correctness/useExhaustiveDependencies: effect event` only if Biome actually reports it.

- [ ] **Step 9: Commit**

```bash
git add "app/[locale]/[projectKey]/[envSlug]/mail" components/app-sidebar.tsx components/header-breadcrumb.tsx messages/
git commit -m "feat: add per-environment Mailpit inbox page"
```

---

### Task 12: End-to-end verification against a real Mailpit

**Files:** none (verification only; fix-ups go in the task they belong to).

- [ ] **Step 1: Full automated suite**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all green. Record the counts.

- [ ] **Step 2: Start a local Mailpit with auth and a webroot**

```bash
printf 'qa:%s\n' "$(htpasswd -nbB qa secret | cut -d: -f2)" > /tmp/mailpit-auth
docker run -d --name mailpit-test -p 8025:8025 -p 1025:1025 \
  -v /tmp/mailpit-auth:/auth:ro axllent/mailpit \
  --webroot /mailpit --ui-auth-file /auth
```

If `htpasswd` is unavailable, drop `--ui-auth-file` and test auth separately.

- [ ] **Step 3: Configure it.** Run `bun run dev` against the local DB (migration from Task 3 applied) and log in as admin. In a dev environment's Settings → Mailpit, enter:
  - URL `http://localhost:8025/mailpit`
  - user `qa`
  - password `secret`

  Then Test connection. Expected: "Connected — Mailpit v…, 0 messages". Save, and confirm the sidebar now shows **Mail**.

  Then try a wrong password. Test connection expected: "Mailpit authentication failed …".

- [ ] **Step 4: Send mail** (HTML with an inline image and a PDF attachment):

```bash
swaks --server localhost:1025 --to qa@example.com --from app@app.test \
  --header "Subject: Reset your password" \
  --attach-type text/html --attach-body '<p>Hi <img src="cid:logo"> <a href="https://example.com/reset?t=1">Reset</a></p>' \
  --attach-type image/png --attach @/usr/share/icons/hicolor/48x48/apps/firefox.png --attach-header "Content-ID: <logo>" \
  --attach-type application/pdf --attach @README.md
```

(Any PNG and any file work. Swap paths as needed.)

Expected on the open inbox page:
- The message appears within ~1 s without a manual refresh ("Live" indicator green).
- The HTML tab shows the inline image.
- Clicking "Reset" opens a new tab.
- Text, Headers and Raw tabs populate.
- The attachment and .eml download with correct filenames.

- [ ] **Step 5: Hostile content check.** Send this HTML body:

```html
<script>alert(1)</script><img src=x onerror=alert(2)><a href="javascript:alert(3)">x</a>
```

Expected: no alert fires. Browser devtools console shows the sandbox blocking the scripts.

- [ ] **Step 6: Search, pagination, delete**
  - Search `subject:reset`: only matching messages show.
  - Select two messages → Delete selected → confirm: they're gone, and `/admin/activity` shows "deleted 2 emails".
  - Delete all matching with a search active: only matching messages are removed.
  - Delete all: inbox is empty.

- [ ] **Step 7: Access control.** Log in as a user whose effective role on the project is `viewer`:
  - Open `/<KEY>/<env>/mail`: "Mail is restricted".
  - `curl -I` (with that session cookie) `/api/environments/<id>/mail/events`: expect `403`.

- [ ] **Step 8: Failure modes**
  - `docker stop mailpit-test`, then reload the inbox: error banner with `ECONNREFUSED`; the Live indicator shows "Reconnecting…"; the network tab shows SSE retries no more often than every ~10 s.
  - `docker start mailpit-test`: the stream recovers on its own.

- [ ] **Step 9: Production build smoke** (runtime is Bun):

```bash
bun run build && (cd .next/standalone && PORT=3100 bun server.js)
```

Repeat Step 4 against port 3100. This confirms that the Bun `WebSocket` accepts `{ headers }` and that the "Live" indicator turns green.

- [ ] **Step 10: Clean up and finish**

```bash
docker rm -f mailpit-test
```

Then use superpowers:finishing-a-development-branch.
