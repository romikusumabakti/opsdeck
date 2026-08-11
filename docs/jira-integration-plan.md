# Jira Integration Plan (OpsDeck ⇄ Jira)

**Status:** Draft · **Written:** 2026-08-11 · **Scope:** the existing project issue
tracker (`issues`, `issueComments`, `issueLabels`, `milestones`).

Goal: let a project mirror a Jira project so an issue tracked as `CMEM-42` in
OpsDeck is the same work item as `CMEM-42` in Jira, without turning OpsDeck into
a Jira client or building a general-purpose sync engine.

---

## Guiding decisions

These are the load-bearing choices. Each picks the boring, canonical option.

| Decision | Choice | Why |
|---|---|---|
| Jira flavor | **Cloud first** (`/rest/api/3`), Data Center behind the same interface | Cloud is the deployment in use; DC only differs in auth (PAT bearer) and base URL, so one `JiraClient` covers both. |
| Auth | **Scoped API token, HTTP Basic** (`email:token`), encrypted at rest | OAuth 2.0 3LO needs an app registration, per-user consent, and refresh-token rotation — all cost for a server-to-server sync with no per-user identity requirement. Forge is out (needs Atlassian-hosted code). |
| Direction | **Pull is the default; push is opt-in per project** | Two-way field-level merge is where sync integrations die. Jira stays source of truth for linked issues; OpsDeck pushes only an explicit, small set of fields. |
| Transport | **Webhook + periodic reconcile poll** | Webhooks alone silently lose events (delivery failure, downtime, retention). A JQL `updated >= lastSyncAt` sweep is the safety net. This pairing is the standard shape. |
| Payload trust | **Webhook is a signal, not data** — always re-fetch the issue by id | Payloads get truncated/reordered, and it removes the need to trust the body. |
| Field mapping | Hardcoded defaults + a per-link `jsonb` override | Jira workflows differ per project; a mapping *table* + editor UI is overengineering for a handful of projects. |
| Rich text | Minimal in-repo **ADF ⇄ Markdown** converter | v3 API is ADF-only and is the future-proof one. `@atlaskit/*` is a heavy editor dep; the standalone md↔adf packages are unmaintained. ~200 lines covering paragraph/heading/list/code/link/emphasis, unknown nodes degrade to text. |
| Sync bookkeeping | Columns on the link row + `activity` entries | The `runs` table is environment-scoped and models an SSH operation; a sync is neither. No new run subsystem. |
| Attachments | **Not mirrored** in v1 — deep-link to Jira | Byte mirroring doubles storage and adds a permission model we don't have. |
| Sprints | **Not mapped** in v1 | Sprints live in the separate Agile REST API. `milestone ⇄ fixVersion` covers the planning need. |

**Explicit assumptions** (flag if wrong — each changes work materially):
1. Jira **Cloud**, one or more sites, credentials owned by a service account.
2. OpsDeck is reachable from Atlassian's network (it is — Caddy is already the
   ingress) so webhooks can be delivered. If not, drop Phase 2's webhook half and
   run poll-only; everything else is unchanged.
3. Linked issues are **Jira-authoritative**. Push-back (Phase 3) is opt-in and
   limited; it is not a merge.

---

## Data model

One migration, additive, safe to apply while running:
`drizzle/20260812000000_jira_integration/`.

### `jira_connections` — workspace-level credential (mirrors `s3Connections`)

```ts
export const jiraConnections = pgTable("jira_connections", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),                       // "TMLI Jira"
  baseUrl: text("base_url").notNull(),                // https://tmli.atlassian.net
  // "cloud" -> Basic (email + API token). "datacenter" -> Bearer (PAT, email null).
  flavor: jiraFlavorEnum("flavor").notNull().default("cloud"),
  email: text("email"),
  // Encrypted via lib/secrets.ts (enc:v1: envelope). Never crosses to a client.
  apiToken: text("api_token").notNull(),
  // Random 32-byte token embedded in the webhook URL path; compared in
  // constant time on delivery. Jira Cloud system webhooks cannot sign a body,
  // so an unguessable URL + server-side re-fetch is the available guard.
  webhookSecret: text("webhook_secret").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```

Add `SafeJiraConnection = Omit<JiraConnection, "apiToken" | "webhookSecret"> &
{ hasToken: boolean }` next to `SafeS3Connection` — same sanitize-before-RSC rule.

### `jira_project_links` — one OpsDeck project ⇄ one Jira project

```ts
export const jiraProjectLinks = pgTable("jira_project_links", {
  projectId: uuid("project_id").primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull()
    .references(() => jiraConnections.id, { onDelete: "cascade" }),
  jiraProjectKey: text("jira_project_key").notNull(),  // "CMEM"
  // Extra JQL AND-ed onto every sweep, e.g. 'labels = opsdeck'. Lets a team
  // mirror a slice of a big Jira project instead of all of it.
  jqlFilter: text("jql_filter"),
  enabled: boolean("enabled").notNull().default(true),
  // false = pull only (default). true = Phase 3 push-back is live.
  pushEnabled: boolean("push_enabled").notNull().default(false),
  // Overrides on top of DEFAULT_STATUS_MAP / TYPE / PRIORITY in lib/jira/mapping.ts.
  // Shape: { status?: Record<string,IssueStatus>, type?: …, priority?: … }
  mappingOverrides: jsonb("mapping_overrides").$type<JiraMappingOverrides>(),
  // Incremental cursor: max remote `updated` we have applied. Swept with a
  // safety overlap (see Phase 2) because JQL `updated` has minute granularity.
  lastSyncAt: timestamp("last_sync_at"),
  lastSyncStatus: jiraSyncStatusEnum("last_sync_status"),  // ok | partial | failed
  lastSyncError: text("last_sync_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // One OpsDeck project per Jira project — prevents two projects fighting over
  // the same remote issues.
  uniqueIndex("jira_links_conn_key_idx").on(t.connectionId, t.jiraProjectKey),
]);
```

### Columns on existing tables

```ts
// issues
jiraIssueId:  text("jira_issue_id"),   // Jira's numeric id — stable across key/project moves
jiraKey:      text("jira_key"),        // display only; CAN change, never a join key
jiraUpdatedAt: timestamp("jira_updated_at"), // remote `fields.updated` we last applied
jiraSyncedAt: timestamp("jira_synced_at"),
// -> uniqueIndex("issues_jira_issue_id_idx").on(t.jiraIssueId)  (partial, WHERE NOT NULL)

// issue_comments
jiraCommentId: text("jira_comment_id"),
// -> uniqueIndex("issue_comments_jira_id_idx").on(t.jiraCommentId) (partial)

// users
jiraAccountId: text("jira_account_id"),  // matched by email on first sync, editable by admin
```

`jiraIssueId` is the join key, `jiraKey` is a label. This is the single most
common bug in Jira integrations — keys change when an issue moves project.

---

## Code layout

```
lib/jira/
  client.ts     JiraClient: auth, fetch wrapper, 429 Retry-After backoff, paging
  types.ts      Narrow zod schemas for the response fields we consume (not the world)
  mapping.ts    status/type/priority/user maps + override merge — pure, unit-tested
  adf.ts        adfToMarkdown / markdownToAdf — pure, unit-tested
  sync.ts       pullProject(), applyRemoteIssue(), reconcile cursor logic
  push.ts       pushIssue(), pushComment() (Phase 3)
actions/jira.ts         connection CRUD, test-connection, link/unlink, "Sync now"
app/api/jira/webhook/[token]/route.ts   webhook receiver (enqueue-and-ack)
app/[locale]/jira/                       admin: connection list/form (mirrors /storage)
```

### `JiraClient` requirements

- Auth header from `flavor`: Basic `base64(email:token)` | Bearer `token`.
- **429/5xx retry** honoring `Retry-After`, capped at 3 attempts, jittered.
- Paging over `/rest/api/3/search/jql` (the `nextPageToken` cursor form — the
  offset-based `/search` endpoint is retired) with an explicit `fields` list.
- Every method takes an already-decrypted token; decryption happens once at the
  call site in the worker, never in a job payload.

### Mapping defaults (`lib/jira/mapping.ts`)

```
Jira statusCategory  →  issueStatus     (category, not name — survives renamed workflows)
  new / To Do        →  open
  indeterminate      →  in_progress
  done               →  closed          (`resolved` reached only via an override)

Jira issuetype.name  →  issueType       Bug→bug, Task/Sub-task→task, Story→story, Epic→epic
Jira priority.name   →  issuePriority   Highest/Blocker→urgent, High→high, Medium→medium,
                                        Low/Lowest→low
Jira accountId       →  users.jiraAccountId, else email match, else null (unassigned)
Jira labels          →  labels (get-or-create by name, workspace-wide as today)
Jira parent          →  issues.parentId (only if the parent is already linked)
Jira fixVersions[0]  →  milestones (get-or-create by name within the project)
```

Reverse maps are derived, with the ambiguous direction pinned explicitly
(`closed`→Done, `resolved`→Done).

---

## Phases

Each phase ships and is useful alone.

### Phase 0 — Connections (no sync yet)

- Migration: `jira_connections` + `jira_project_links` + issue/comment/user columns.
- `lib/jira/client.ts` + `types.ts`.
- `actions/jira.ts`: `createConnection` / `updateConnection` / `deleteConnection`
  / `testConnection` (GET `/rest/api/3/myself` → shows the account name).
  All gated on `admin` capability; token encrypted with `encryptSecret`.
- `/[locale]/jira` admin page, copied from the `/storage` shape (list + form +
  "leave blank to keep token").
- Nav entry + i18n keys in all four `messages/*.json`.

**Done when:** an admin can save a Jira site and see "Connected as …".

### Phase 1 — Link a project + initial import (pull only)

- Project settings (`app/[locale]/[projectKey]/settings/page.tsx`) gets a **Jira
  card**: connection picker, Jira project key (validated against
  `/rest/api/3/project/search`), optional JQL filter, enable toggle, "Sync now",
  last-sync status line.
- `JobMap` gains `"jira/sync.project": { projectId: string; full?: boolean }`.
  **`enqueue()` must grow an options arg** — Jira jobs are idempotent and should
  retry with backoff, unlike the `attempts: 1` SSH jobs:

  ```ts
  export async function enqueue<N extends JobName>(
    name: N, data: JobMap[N], opts?: { attempts?: number; backoff?: …; jobId?: string }
  )
  ```

  Pass `jobId: \`jira-sync-${projectId}\`` so overlapping syncs of one project
  collapse into one instead of racing.
- `lib/jira/sync.ts#pullProject`:
  1. JQL `project = KEY [AND <filter>] [AND updated >= "<cursor>"] ORDER BY updated ASC`.
  2. Page through, `applyRemoteIssue()` per issue in a transaction:
     - match by `jiraIssueId`; else insert with the **next OpsDeck `number`**
       (same `max+1` + 23505-retry loop as `createIssue`);
     - skip if `fields.updated <= issues.jiraUpdatedAt` (idempotent replay);
     - map fields, sync labels, upsert comments by `jiraCommentId`,
       `description` via `adfToMarkdown`;
     - always set `jiraUpdatedAt` / `jiraSyncedAt`.
  3. Advance `lastSyncAt` to the max applied `updated`, write status/error.
- Issue detail + list show a `CMEM-42 ↗` badge linking to Jira when linked.
- Parent/`fixVersion` resolution runs as a **second pass** after the page loop,
  so a child imported before its parent still links.

**Done when:** "Sync now" imports a Jira project and re-running it changes nothing.

### Phase 2 — Stay in sync (webhook + reconcile)

- `app/api/jira/webhook/[token]/route.ts`:
  - constant-time compare `token` against `jira_connections.webhook_secret`;
  - parse only `{ webhookEvent, issue.id, comment.id }`, enqueue
    `"jira/issue.changed": { connectionId, jiraIssueId }`, return `200`
    immediately (Jira retries slowly and disables noisy endpoints);
  - the worker **re-fetches** the issue and runs the same `applyRemoteIssue()`.
    Deleted-issue events set `status: closed` + a note — never hard-delete.
- Register the webhook once per connection from `testConnection`'s sibling
  action (`POST /rest/api/3/webhook`), scoped to
  `jira:issue_created|updated|deleted`, `comment_created|updated|deleted`.
  Also document the manual UI path, since Cloud dynamic webhooks expire after
  30 days and need refreshing — a **weekly repeatable job** re-registers them.
- Reconcile sweep: BullMQ repeatable `jira/sync.project` every 15 min per enabled
  link, with the cursor rewound **5 minutes** from `lastSyncAt` (JQL `updated`
  resolves to the minute, and a clock skew between sites is normal). The
  `jiraUpdatedAt` skip makes the overlap free.

**Done when:** a status change in Jira lands in OpsDeck within seconds, and
killing the app for an hour still converges after the next sweep.

### Phase 3 — Push-back (opt-in per project)

Only these fields, only when `pushEnabled`:

| OpsDeck change | Jira call |
|---|---|
| status | `POST /issue/{id}/transitions` — resolve via `GET /transitions`; if no transition reaches the target category, record a failure in `activity` and revert nothing |
| assignee | `PUT /issue/{id}/assignee` (needs `users.jiraAccountId`) |
| title / description / priority | `PUT /issue/{id}` (description via `markdownToAdf`) |
| new comment | `POST /issue/{id}/comment` |

- Triggered from the existing actions (`updateIssue`, `addComment`) — enqueue
  `"jira/push.issue"` **after** the transaction commits, never inside it.
- **Echo suppression:** the push job stores the `updated` value Jira returns into
  `jiraUpdatedAt`, so the webhook it causes is skipped by the existing
  `updated <= jiraUpdatedAt` guard. `applyRemoteIssue()` never enqueues a push —
  the two paths are separate functions, not one shared writer.
- **Conflict:** if the remote `updated` moved past our `jiraUpdatedAt` between
  read and write, Jira wins; the discarded local edit is written to `activity`
  as `issue.jira_conflict` with both values. No merge UI.
- Issue-create push is **out of scope** — new work is created in Jira. (Revisit
  only if teams actually file in OpsDeck first.)

### Phase 4 — Polish

- User-mapping table in the Jira admin page (unmatched Jira accounts → OpsDeck
  users), seeded by email match.
- Mapping-override editor: read the project's real statuses from
  `/rest/api/3/project/{key}/statuses` and let an admin repoint each one.
- Unlink flow: keep the rows, clear `jira*` columns, one confirm dialog.
- `issues` list filter: "linked / not linked to Jira".

---

## Testing

Pure functions only — no network in CI, matching the existing `tests/` style:

- `tests/jira-adf.test.ts` — round-trip markdown↔ADF for every supported node,
  unknown-node degradation.
- `tests/jira-mapping.test.ts` — status category mapping, override merge,
  unknown priority/type fallbacks, reverse-map ambiguity pins.
- `tests/jira-sync.test.ts` — `applyRemoteIssue` decision logic against a fake
  db + fixture payloads: insert vs update vs skip-stale, comment upsert.
- Manual: a scratch Jira project for webhook + transition behavior.

## Security notes

- API tokens use `encryptSecret`; `SECRETS_KEY` is already required. Tokens are
  never in a BullMQ payload (job carries ids; the worker re-loads and decrypts) —
  same rule the existing jobs follow.
- The webhook URL contains the secret, so it will appear in Caddy access logs.
  Either exclude that path from logging or accept it — the endpoint only accepts
  an id and re-fetches, so a leaked token buys an attacker a forced re-sync, not
  data injection. Worth stating in the deploy notes.
- Scope the Atlassian API token to the minimum (read work items; add write only
  when Phase 3 ships) and use a dedicated service account, not a person's.

## Rollout

1. Apply the migration (additive; no downtime).
2. Set up one connection, link **one** low-stakes project, run a full pull, diff
   counts against Jira.
3. Enable the webhook, watch a day of sweeps for `lastSyncStatus != ok`.
4. Roll out per project. Push-back stays off until a team asks for it.

## Deliberately not doing

Custom-field mapping · sprint/board sync · attachment mirroring · issue creation
from OpsDeck into Jira · a mapping DSL · per-user OAuth · bidirectional
field-level merge · a `jira_sync_runs` audit table (the `activity` log covers it).
