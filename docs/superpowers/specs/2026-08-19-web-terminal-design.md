# Web Terminal — Design

Date: 2026-08-19
Status: approved, ready for implementation planning

## Goal

An interactive SSH shell in the browser, reachable from two places:

1. **Server list** (`/servers`) — the row's `⋯` menu gets an "Open terminal" item.
2. **File explorer** (`/servers/[id]/files`) — a toolbar button "Open in terminal"
   that opens a shell already `cd`-ed into the folder being browsed.

Both land on one full-page route: `/servers/[id]/terminal[?cwd=<path>]`.

## Decisions taken (and their alternatives)

| Decision | Chosen | Rejected |
|---|---|---|
| Access | Admin only (matches the file explorer's `requireAdmin`), open/close written to the activity log | Maintainer access; full session recording (storage + retention + secrets end up in the transcript) |
| Session life | PTY survives 60s after socket loss, reattach replays a scrollback ring buffer | Ephemeral (reload = lost shell); tmux on every remote host (needs tmux on all 24 servers) |
| UI | One full-page route, deep-linkable, one session per browser tab | Drawer inside the explorer; global multi-tab dock |
| Transport | WebSocket sidecar service | Custom Next server; SSE-down + POST-up |

### Why a sidecar and not a custom Next server

Next 16 has no WebSocket support in route handlers. `router-server.ts` deliberately
leaves unmatched upgrade requests unhandled so a custom WS server can coexist — but
using that means replacing the standalone `server.js` entrypoint with a hand-rolled
one, and running that same custom server in development instead of `next dev`.

A separate process avoids both. It also decouples the lifetime of a live root shell
from the Next request path: a hot reload, a route recompile, or a Next major upgrade
cannot kill a session. The cost is one compose service, one Caddy route, and a ticket
handshake — all of which are simple, testable, and independent of framework internals.

### Why a ticket and not the session cookie

The sidecar is not a Next process, so honouring the better-auth cookie would mean
reimplementing session validation (and role resolution) a second time, in a second
place, that must stay in sync forever.

Instead the Next app — which already knows the session and the role — mints a
short-lived, single-use ticket. The sidecar stays dumb: verify a MAC, read the
payload, dial SSH. `cwd` is confined *before* it is signed, so the sidecar never
has to make an authorization decision.

## Architecture

```
browser ──HTTPS──> Caddy ──> app:3000        (Next: pages, ticket mint)
   │                 │
   └──WS /ws/terminal┴─────> terminal:3001   (Bun.serve + ssh2 shell)
                                   │
                                   └──SSH──> managed server (sshd allocates the PTY)
```

The sidecar runs **the same Docker image** as the app with a different `CMD`. The
builder stage adds:

```
bun build lib/terminal/server.ts --target=bun --conditions react-server \
  --outfile terminal-server.js
```

`--conditions react-server` makes the `server-only` package resolve to its empty
stub, so the sidecar imports `lib/db`, `lib/secrets` and `lib/activity` verbatim.
No duplicated data layer, no second copy of the decryption code.

There is no `node-pty` dependency and no local PTY. The remote `sshd` allocates the
tty when `ssh2` opens a shell channel.

## Components

| Path | Responsibility | Depends on |
|---|---|---|
| `lib/terminal/protocol.ts` | Wire message types; ticket mint/verify | `node:crypto` only — pure, no I/O |
| `lib/terminal/session.ts` | Session registry: ring buffer, grace timer, idle timer, limits | `ssh2` |
| `lib/terminal/server.ts` | Sidecar entry: `Bun.serve`, upgrade + origin check, message loop, audit calls | the two above, `lib/db`, `lib/secrets`, `lib/activity` |
| `app/api/terminal/ticket/route.ts` | `POST {serverId, cwd?}` → `requireAdmin`, confine `cwd`, return `{ticket, wsUrl}` | `lib/terminal/protocol`, `lib/explorer/path` |
| `components/terminal.tsx` | xterm host, WS client, reconnect, resize, theme | `@xterm/*` |
| `app/[locale]/servers/[id]/terminal/page.tsx` | Route, `requireAdmin`, `PageHeader` | `actions/servers` |
| `app/[locale]/servers/[id]/terminal/loading.tsx` | Skeleton, matching the existing route conventions | — |

Each unit is testable alone: `protocol.ts` is pure functions over strings and
buffers; `session.ts` takes an already-authorized descriptor and an ssh2 connection
factory; `server.ts` is the only place that touches sockets.

### Files edited

- `app/[locale]/servers/servers-client.tsx` — `DropdownMenuItem` → `/servers/${id}/terminal`
- `components/file-explorer.tsx` — toolbar button, rendered only when `source.kind === "sftp"`, linking to `/servers/${source.serverId}/terminal?cwd=${encodeURIComponent(path)}`
- `Dockerfile` — build the sidecar bundle in the builder stage, copy it into the runner
- `compose.yaml` — `terminal` service (same image, `expose: 3001`, no published port)
- `Caddyfile` — `handle /ws/terminal*` → `terminal:3001`
- `lib/env.ts` — validate `TERMINAL_WS_PORT`, `NEXT_PUBLIC_TERMINAL_WS_PATH`
- `.env.example` — document both
- `messages/{ar,en,id,zh}.json` — every new string, all four locales

## Ticket format

Key: derived from the existing `SECRETS_KEY` with `hkdfSync("sha256", …)`, info
`"terminal-ticket-v1"`. No new secret to distribute, and a key distinct from the
at-rest encryption key. If Bun's `node:crypto` turns out not to implement
`hkdfSync`, fall back to `createHmac("sha256", masterKey).update("terminal-ticket-v1")`
— same separation property, one less API dependency. Verify at implementation time.

```
ticket  = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload))
payload = { v: 1, uid, sid, cwd, exp, jti }
```

- `exp` = mint time + 30s. Long enough for a page load, short enough that a leaked
  ticket is worthless.
- `jti` = random 16 bytes, held in a TTL set on the sidecar until `exp`. A replayed
  ticket is rejected even inside its validity window.
- Compared with `timingSafeEqual`.
- Sent in the **first WebSocket message**, never in the URL — query strings land in
  proxy access logs.

`cwd` is validated at mint time with `confineSftpPath(server.sftpRoot, cwd)`. An
out-of-root `cwd` is a 400, not a silent fallback.

## Wire protocol

Text frames carry JSON control messages; binary frames carry tty bytes. No framing
header, no length prefix — the WebSocket frame type is the discriminator.

Client → server:

```
{ t: "hello",  ticket, cols, rows, sessionId? }   // always first
{ t: "resize", cols, rows }
<binary>                                          // stdin
```

Server → client:

```
{ t: "ready", sessionId }
{ t: "exit",  code, signal }
{ t: "error", message }        // then close
<binary>                                          // stdout + stderr, interleaved as the tty produced them
```

A connection whose first message is not a valid `hello` is closed immediately.

## Session lifecycle

Registry: `Map<sessionId, Session>` in the sidecar's memory.

```
Session = { ssh, stream, ring, userId, serverId, socket | null,
            graceTimer, idleTimer, openedAt }
```

- **Open.** Verify ticket → load server row → `decryptSecret(password)` →
  `ssh.shell({ term: "xterm-256color", cols, rows })`. If `cwd` is set, write
  `cd '<cwd>'\n` as the first stdin line. Reply `ready`.
- **Detach.** On socket close, `socket = null` and a 60s grace timer starts. The PTY
  keeps running; output accumulates in `ring` (256 KB, wrapping).
- **Reattach.** `hello` carrying a `sessionId` whose `userId` and `serverId` match
  the new ticket → cancel the grace timer, replay `ring`, attach. A mismatch is
  treated as an unknown session, not an error to explain.
- **Reap.** Grace expiry, 30 min with no stdin, or 8h absolute → close channel,
  dispose ssh, delete entry.
- **Limits.** 4 concurrent sessions per user; the 5th `hello` gets an `error` frame.
- **Backpressure.** Pause the ssh stream above `ws.bufferedAmount > 1 MB`, resume
  below 256 KB. Without this, `cat` on a large file grows the sidecar heap until it
  dies, taking every other session with it.

State lives only in memory. A sidecar restart drops all sessions — acceptable, and
the reason the grace buffer is capped rather than durable.

## Audit

`recordActivity` (best-effort, already swallows its own failures) on:

| Action | Data |
|---|---|
| `terminal.open` | server name, host |
| `terminal.close` | server name, duration seconds, exit code |
| `terminal.denied` | server name, reason |

Keystrokes and output are **not** stored, per the access decision. The activity page
renderer needs an i18n template per action, in all four locales.

## Frontend

`@xterm/xterm` with the `fit`, `webgl`, `clipboard`, `web-links` and `unicode11`
addons, loaded through `next/dynamic` with `ssr: false` — xterm touches `window` at
construction.

- Theme derived from `next-themes`, so the terminal follows light/dark like the rest
  of the app.
- `ResizeObserver` → fit addon → send `{t:"resize"}`. Debounced to one message per
  animation frame.
- Status line: connected / reconnecting / closed, with a reconnect button. Reconnect
  fetches a fresh ticket (the old one is expired and spent) and sends `hello` with
  the stored `sessionId`.

## Security

The gate is `requireAdmin` in two places: the page render and the ticket route. The
page check alone would not be enough — the ticket route is directly callable.

Other measures: origin check on upgrade; sidecar `expose`d but never published, so
Caddy is the only route in; ticket in a frame body rather than a URL; 30s expiry;
single-use `jti`.

**Stated plainly:** this feature grants a full interactive shell as the server's SSH
user, which for every server currently in the list is `root`. `sftpRoot` confines the
file explorer; it does not confine this. Anyone who can open a terminal can `cd /`,
read any file on the host, and change anything. That is inherent to what a terminal
is, not a defect in this design. The mitigations available are the admin-only gate
(chosen) and, if a narrower blast radius is ever wanted, a restricted SSH user per
server — a separate change to how server credentials are provisioned.

## Testing

`bun test`, alongside the existing suite:

- `protocol.ts` — round-trip mint/verify; expired ticket; tampered payload; tampered
  MAC; replayed `jti`; malformed input.
- `session.ts` — ring buffer wrap and replay; grace timer reaps; reattach with a
  matching descriptor succeeds and with a mismatched one does not; per-user limit.
- `cwd` confinement — the `confineSftpPath` cases that matter here (`..`, absolute
  escape, symlink-shaped input).
- Integration against an in-process `ssh2.Server` fixture: shell opens, resize
  reaches the server, exit propagates, disconnect → reattach replays.

Manual pass before merge: `vim`, `htop`, `less`, window resize mid-session, network
drop and recovery inside 60s, and after 60s.

## Out of scope

Session recording, multi-tab docks, tmux persistence, non-admin access, file upload
via the terminal, and a terminal for S3-backed explorer sources (there is no host to
shell into).
