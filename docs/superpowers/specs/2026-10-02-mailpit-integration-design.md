# Mailpit integration per environment — design

Date: 2026-10-02
Status: approved (brainstorming), pending spec review

## Goal

QA and developers can read the email an environment's application sends
(OTP, password reset, notifications) directly inside OpsDeck, scoped to that
environment, without opening a separate Mailpit tab or holding its
credentials.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Purpose | Inbox viewer inside OpsDeck (not a link-out, not provisioning) |
| Connectivity | Direct HTTP URL reachable from the OpsDeck host, optional Basic Auth |
| v1 scope | List + search + detail, delete, attachment download, realtime updates |
| Access | Member and above (viewer cannot read message bodies) |
| Architecture | Server-side proxy: browser never talks to Mailpit |

Out of scope for v1: release/relay, tags, provisioning Mailpit containers,
using Mailpit in automated test runs, SSH-tunnelled access.

## Architecture

```
browser ──(server actions / route handlers, session + `mail` capability)──▶ OpsDeck
OpsDeck ──(fetch / WebSocket, URL + Basic Auth from DB)──────────────────▶ Mailpit /api/v1/*, /api/events
```

The Mailpit URL and credentials are always read from the trusted
environment record, never accepted from the client, so the proxy cannot be
pointed at an arbitrary host (SSRF), the same rule `actions/mock-time.ts`
follows.

## Data model

New 1:1 table `environment_mailpit` (row present = integration enabled):

| Column | Type | Notes |
|---|---|---|
| `environment_id` | uuid PK, FK → `environments.id` on delete cascade | |
| `url` | text not null | Base URL including any webroot, e.g. `https://mail-qa.example.com/` or `http://10.0.0.5:8025`. |
| `username` | text null | Basic Auth user; not secret. |
| `password` | text null | Basic Auth password, encrypted with `lib/secrets.ts` (`enc:v1:`). |
| `updated_at` | timestamp not null default now() | |

Why a separate table rather than columns on `environments`: whole
`environments` rows reach the client in several places
(`listEnvironments` spreads `getTableColumns(environments)`, the project
catalog loads `environments` via relations, create/update return the row).
A secret column there would leak (encrypted) into RSC payloads; a separate
table keeps it out by construction. It also keeps the Mailpit config out of
`environment_services`, which models SSH-managed units
(`serverId`/`serviceType`/`serviceName` are required).

- Migration: `drizzle/20261002000000_mailpit/migration.sql`, hand-written,
  `BEGIN; … COMMIT;`, `CREATE TABLE IF NOT EXISTS`, matching existing ones.
- `lib/mailpit/config.ts` (`server-only`) is the single decrypt boundary:
  `loadMailpitConfig(environmentId)` returns `{ url, username, password }`
  or null.
- `listEnvironments` adds a `hasMailpit` boolean (EXISTS subquery) to
  `EnvironmentListItem`, so the sidebar can show the entry without loading
  config.
- Validation (`lib/validation.ts`): URL must parse and use `http:`/`https:`;
  password follows the existing "blank on edit = keep" convention used by
  `dbPassword` / `mockTimeApiKey`. Saving with an empty URL removes the row.

## Configuration UI

A separate **Mailpit** card on the environment settings page
(`app/[locale]/[projectKey]/[envSlug]/settings`, config tab, admin-only), with
its own small form (URL, username, password) and its own actions in
`actions/mailpit-settings.ts`: `getMailpitSettings`, `saveMailpitSettings`
and `testMailpitConnection`. Keeping it out of `components/environment-form.tsx` leaves that
large create/clone/edit form and its transaction untouched. Mailpit is
configured after the environment exists. Saving records `recordActivity`
(`mailpit.configured` / `mailpit.removed`).

A **Test connection** button calls `GET /api/v1/info` with the form's
values. When the password field is blank it uses the stored password. The
action is admin-only, since the URL comes from the client. It reports the
version and message count, or the error.

## Mailpit client — `lib/mailpit.ts` (`server-only`)

Thin typed wrapper over `fetch`; each response parsed with a zod schema
(only the fields OpsDeck uses).

| Function | Mailpit endpoint |
|---|---|
| `getInfo` | `GET /api/v1/info` |
| `listMessages({ start, limit })` | `GET /api/v1/messages` |
| `searchMessages({ query, start, limit })` | `GET /api/v1/search` |
| `getMessage(id)` | `GET /api/v1/message/{id}` |
| `getRaw(id)` | `GET /api/v1/message/{id}/raw` |
| `getPart(id, partId)` | `GET /api/v1/message/{id}/part/{partId}` (streamed) |
| `deleteMessages(ids \| "all")` | `DELETE /api/v1/messages` |
| `deleteSearch(query)` | `DELETE /api/v1/search` |
| `getHeaders(id)` | `GET /api/v1/message/{id}/headers` |
| `eventsUrl` | `ws(s)://…/api/events` |

- Config input: `{ url, username, password }` built from the loaded
  environment by one helper (`mailpitConfig(environment)`), which returns null
  when not configured.
- URL joining respects the base path (webroot).
- Timeout via `AbortSignal.timeout` (10 s for API calls).
- Errors normalised to a short reason; the existing `describeFetchError`
  logic moves to a shared `lib/fetch-error.ts` and both mock-time and
  Mailpit use it. 401 maps to "authentication failed".
- Pure helpers (URL building, query params, HTML rewriting, header building)
  are exported separately so they can be unit-tested without network.

## Access control

New capability `mail` in `lib/roles.ts`, minimum role `member`, covering
read, delete, download and the event stream. Checked with
`requireCapability("mail", { environmentId })` in actions and with the
equivalent non-redirecting check in route handlers (401/403 JSON).

## Inbox UI — `app/[locale]/[projectKey]/[envSlug]/mail`

- Sidebar entry `mail` (icon `Mail`) in `projectItems`, shown only when the
  environment's `hasMailpit` is true. The sidebar only knows the global
  role (per-project membership is resolved server-side), so role gating
  happens on the page.
- Page server component: when not configured, an empty state (admins get a
  link to settings); when the effective role lacks `mail`, an empty state
  saying mail is restricted to members. The actions and routes enforce the
  capability independently.
- Two-pane client layout:
  - **Left:** search box (Mailpit search syntax: `to:`, `from:`,
    `subject:`, `is:unread`, …), paginated list (from, subject, snippet,
    time, unread dot, attachment icon), row checkboxes.
  - **Right:** selected message: header block (from, to, cc, date,
    subject), tabs **HTML / Text / Headers / Raw**, attachment list with
    download links. Mailpit itself marks a message read when
    `GET /api/v1/message/{id}` is called, so no separate mark-read call.
- Actions: delete message, delete selected, delete all (or all matching the
  current search), all behind a confirm dialog. Each delete is recorded with
  `recordActivity`.
- Data loading via server actions (`actions/mail.ts`: `listMail`,
  `getMail`, `getMailSource`, `deleteMail`) returning
  `{ success, data } | { success: false, error }`, the same shape as
  mock-time.

## HTML rendering

`next.config.ts` sends `frame-ancestors 'none'` + `X-Frame-Options: DENY` on
every path, so an iframe pointing at an OpsDeck route would be blocked. The
HTML is therefore returned by the `getMail` action and rendered with
`<iframe srcdoc sandbox="allow-popups allow-popups-to-escape-sandbox">`
(no `allow-scripts`, no `allow-same-origin`).

`lib/mailpit/html.ts` prepares the document server-side:

- Inline `cid:` references are rewritten to `data:` URIs (parts fetched from
  Mailpit, per-part cap 2 MB, total cap 10 MB; above the cap the reference is
  left as-is and renders broken).
- A `<head>` prelude is injected:
  `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`,
  `<meta name="referrer" content="no-referrer">` and `<base target="_blank">`,
  so links (reset/verify links QA needs to click) open in a new tab.
- Remote `https:` images load (test environments; no toggle).

## Route handlers — `app/api/environments/[environmentId]/mail/`

All are `runtime = "nodejs"`, `dynamic = "force-dynamic"`, authenticate the
session and the `mail` capability, and load config from the DB.

### `messages/[id]/part/[partId]`

Streams an attachment with `Content-Disposition: attachment` (RFC 6266
`filename*` encoding), the part's content type, and `nosniff`. Always
attachment, never inline, so attacker-controlled HTML/SVG cannot run on the
OpsDeck origin.

### `messages/[id]/raw`

Returns the `.eml` source as `message/rfc822` attachment download; the Raw
tab fetches it as text.

### `events`

Realtime relay: opens a WebSocket to Mailpit `/api/events` (Bun WebSocket
client with an `Authorization` header) and forwards each event as SSE. It uses the same
shape as the log stream route: a 10-minute cap, a 15 s heartbeat, and cleanup on client abort. The client
`EventSource` reconnects automatically. On `new` / `delete` / `truncate` /
`update` events the inbox refreshes its list (debounced); other event types
are ignored.

## Error handling

| Situation | Behaviour |
|---|---|
| Not configured | Empty state; sidebar item hidden |
| Mailpit unreachable / timeout | Error banner with normalised reason, retry button |
| 401 from Mailpit | "Mailpit authentication failed — check environment settings" |
| Message deleted meanwhile (404) | Detail pane shows "message no longer exists", list refreshes |
| SSE drops | EventSource reconnects; manual refresh button always available |

## i18n

New `mail` and `mailpitSettings` namespaces, `nav.mail`, activity strings, and
errors in all five `messages/{ar,en,es,id,zh}.json`.

## Testing (`bun test`, pure functions)

- `tests/mailpit.test.ts`: URL joining with/without webroot, query params,
  Basic Auth header, zod parsing of sample responses (fixtures in
  `tests/fixtures/mailpit-*.json`), error normalisation (401, timeout,
  ECONNREFUSED).
- HTML preparation: `cid:` → `data:` mapping, size caps, untouched non-cid
  URLs, prelude injection with and without an existing `<head>`.
- Event parsing: Mailpit WebSocket frames → relevant/ignored types.
- `tests/validation.test.ts`: Mailpit settings schema (URL scheme, lengths).
- Roles: `mail` capability granted to member+, denied to viewer.

Manual verification: run a local Mailpit (`axllent/mailpit`), point a dev
environment at it, send mail with `swaks`/`curl smtp://`, check the list,
the search, the HTML/inline images, the download, the delete, live arrival,
and that a viewer is refused.
