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

Three nullable columns on `environments` (Mailpit is an HTTP endpoint, not an
SSH-managed deployable unit, so it does not fit `environment_services`, which
requires `serverId`/`serviceType`/`serviceName`):

| Column | Type | Notes |
|---|---|---|
| `mailpit_url` | text | Base URL including any webroot, e.g. `https://mail-qa.example.com/` or `http://10.0.0.5:8025`. Null = integration disabled. |
| `mailpit_username` | text | Basic Auth user; not secret. |
| `mailpit_password` | text | Basic Auth password, encrypted with `lib/secrets.ts` (`enc:v1:`). |

- Migration: `drizzle/20261002000000_mailpit/migration.sql`, hand-written,
  `BEGIN; … COMMIT;`, `ADD COLUMN IF NOT EXISTS`, matching existing ones.
- `loadEnvironmentWithServers` decrypts `mailpitPassword`.
- `sanitizeEnvironment` strips `mailpitPassword` and adds
  `hasMailpitPassword`; `mailpitUrl` and `mailpitUsername` stay visible.
- Validation (`lib/validation.ts`): URL must parse and use `http:`/`https:`;
  password follows the existing "blank on edit = keep" convention used by
  `dbPassword` / `mockTimeApiKey`.

## Configuration UI

`components/environment-form.tsx` gets a "Mailpit" section (URL, username,
password) handled by the existing create/update actions in
`actions/environments.ts` (admin-only, `recordActivity` on change).

A **Test connection** button calls a server action that hits
`GET /api/v1/info` with the form's values (admin only, since those values come
from the client) and reports version / message count or the error.

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
| `markRead(ids)` | `PUT /api/v1/messages` |
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
  environment has `mailpitUrl` set and the effective role has `mail`.
- Page server component: when not configured, an empty state (admins get a
  link to settings); when role lacks `mail`, the page refuses like other
  gated pages.
- Two-pane client layout:
  - **Left:** search box (Mailpit search syntax: `to:`, `from:`,
    `subject:`, `is:unread`, …), paginated list (from, subject, snippet,
    time, unread dot, attachment icon), row checkboxes.
  - **Right:** selected message: header block (from, to, cc, date,
    subject), tabs **HTML / Text / Headers / Raw**, attachment list with
    download links. Opening a message marks it read.
- Actions: delete message, delete selected, delete all (or all matching the
  current search), all behind a confirm dialog. Each delete is recorded with
  `recordActivity`.
- Data loading via server actions (`actions/mail.ts`: `listMail`,
  `getMail`, `deleteMail`, `markMailRead`) returning
  `{ success, data } | { success: false, error }`, the same shape as
  mock-time.

## Route handlers — `app/api/environments/[environmentId]/mail/`

All are `runtime = "nodejs"`, `dynamic = "force-dynamic"`, authenticate the
session and the `mail` capability, and load config from the DB.

### `messages/[id]/html`

Serves the message HTML for an `<iframe sandbox>` (no `allow-scripts`, no
`allow-same-origin`).

- Response headers: `Content-Security-Policy: sandbox; default-src 'none';
  img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- Inline `cid:` references are rewritten to `data:` URIs server-side
  (parts fetched from Mailpit, per-part size cap, e.g. 2 MB; above the cap the
  image is left broken). This avoids the sandboxed (opaque-origin) iframe
  needing session cookies to fetch parts.
- Remote `https:` images are allowed (test environments; no toggle).

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

New `mail` namespace, `nav.mail`, environment-form field labels/hints, and
errors in all five `messages/{ar,en,es,id,zh}.json`.

## Testing (`bun test`, pure functions)

- `tests/mailpit.test.ts`: URL joining with/without webroot, query params,
  Basic Auth header, zod parsing of sample responses (fixtures in
  `tests/fixtures/mailpit-*.json`), error normalisation (401, timeout,
  ECONNREFUSED).
- HTML rewrite: `cid:` → `data:` mapping, size cap, untouched non-cid URLs.
- Header builders: CSP string, `Content-Disposition` with non-ASCII
  filenames.
- `tests/validation.test.ts`: Mailpit URL scheme validation, blank password
  keeps existing.
- Roles: `mail` capability granted to member+, denied to viewer.

Manual verification: run a local Mailpit (`axllent/mailpit`), point a dev
environment at it, send mail with `swaks`/`curl smtp://`, check the list,
the search, the HTML/inline images, the download, the delete, live arrival,
and that a viewer is refused.
