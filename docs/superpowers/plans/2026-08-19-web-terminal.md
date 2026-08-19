# Web Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins an interactive SSH shell in the browser, opened from the server list or from the file explorer at the folder being browsed.

**Architecture:** Next 16 cannot serve WebSockets from route handlers, so a separate Bun process (same Docker image, different `CMD`) owns the sockets and the SSH shell channels. The Next app mints a 30-second single-use HMAC ticket; the sidecar verifies it, loads the server's credentials from the same database, and opens a PTY on the remote host via `ssh2`. Sessions live in the sidecar's memory and survive 60 seconds of socket loss so a reload or a wifi blip reattaches with replayed scrollback.

**Tech Stack:** Bun 1.3, Next 16 (App Router), `ssh2` via `node-ssh` (already a dependency), Drizzle + Postgres, `@xterm/xterm` v6 + addons, `bun:test`, Caddy, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-19-web-terminal-design.md`

## Global Constraints

- Runtime is **Bun 1.3.14**; package manager is `bun`. Never introduce `npm`/`yarn` lockfiles.
- Every new user-facing string goes into **all four** locale files: `messages/ar.json`, `messages/en.json`, `messages/id.json`, `messages/zh.json`. A key present in one and missing in another is a build-time type error.
- `tsconfig.json` sets `verbatimModuleSyntax` (type imports must say `import type`) and `noUncheckedIndexedAccess` (`arr[i]` is `T | undefined`).
- Access control: **admin only**, enforced in two places — the page (`requireAdmin()`) and the ticket route (`getServerSession()` + `isAdmin()`).
- Audit: `terminal.open` / `terminal.close` / `terminal.denied` via `recordActivity`. **No keystrokes or output are ever stored.**
- Ticket TTL is **30 000 ms**; grace period after socket loss is **60 000 ms**; idle kill at **30 min** without stdin; absolute cap **8 h**; **4** concurrent sessions per user; scrollback ring buffer **256 KB**; backpressure pauses above **1 MB** buffered and resumes below **256 KB**.
- Ticket signing key is derived from the existing `SECRETS_KEY` with info string `"terminal-ticket-v1"`. **No new secret is introduced.**
- The ticket travels in the first WebSocket message, **never** in a URL.
- Lint/format with `bun run check` (Biome). Typecheck with `bun run typecheck`. Tests with `bun test`.
- Commit after every task. Conventional-commit subjects, imperative mood.

---

### Task 1: Ticket protocol and wire types

Pure module, no I/O, importable from three places: the Next route handler (mint), the sidecar (verify), and the client component (types only — erased at compile time).

**Files:**
- Create: `lib/terminal/protocol.ts`
- Test: `tests/terminal-protocol.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ClientMessage`, `type ServerMessage`, `type TicketPayload`
  - `mintTicket(input: { uid: string; sid: string; cwd: string }, now?: number): string`
  - `verifyTicket(ticket: string, now?: number): { ok: true; payload: TicketPayload } | { ok: false; reason: "malformed" | "bad-signature" | "expired" }`
  - `createNonceGuard(): { accept(jti: string, exp: number, now?: number): boolean }`
  - `parseClientMessage(raw: string): ClientMessage | null`
  - `const TICKET_TTL_MS = 30_000`

Note: this file must **not** import `server-only`. The client component imports its message types, and although `import type` is erased, keeping the module free of the guard makes that safe by construction rather than by accident.

- [ ] **Step 1: Write the failing test**

Create `tests/terminal-protocol.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import {
  createNonceGuard,
  mintTicket,
  parseClientMessage,
  TICKET_TTL_MS,
  verifyTicket,
} from "@/lib/terminal/protocol";

// A deterministic 32-byte key, same convention as tests/secrets.test.ts.
beforeAll(() => {
  process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
});

const SUBJECT = { uid: "user-1", sid: "server-1", cwd: "/srv/app" };

describe("ticket mint/verify", () => {
  it("round-trips a payload", () => {
    const now = 1_000_000;
    const ticket = mintTicket(SUBJECT, now);
    const result = verifyTicket(ticket, now + 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.uid).toBe("user-1");
    expect(result.payload.sid).toBe("server-1");
    expect(result.payload.cwd).toBe("/srv/app");
    expect(result.payload.exp).toBe(now + TICKET_TTL_MS);
  });

  it("issues a distinct jti per mint, so two tickets are never interchangeable", () => {
    const a = verifyTicket(mintTicket(SUBJECT, 1000), 1001);
    const b = verifyTicket(mintTicket(SUBJECT, 1000), 1001);
    expect(a.ok && b.ok).toBe(true);
    if (!(a.ok && b.ok)) return;
    expect(a.payload.jti).not.toBe(b.payload.jti);
  });

  it("rejects a ticket past its expiry", () => {
    const ticket = mintTicket(SUBJECT, 1000);
    const result = verifyTicket(ticket, 1000 + TICKET_TTL_MS);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a tampered payload", () => {
    const ticket = mintTicket(SUBJECT, 1000);
    const [body, mac] = ticket.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        uid: "user-1",
        sid: "OTHER-SERVER",
        cwd: "/",
        exp: 1000 + TICKET_TTL_MS,
        jti: "x",
      }),
      "utf8"
    ).toString("base64url");
    expect(body).not.toBe(forged);
    const result = verifyTicket(`${forged}.${mac}`, 1001);
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a tampered signature and malformed input", () => {
    const ticket = mintTicket(SUBJECT, 1000);
    const [body] = ticket.split(".");
    expect(verifyTicket(`${body}.AAAA`, 1001)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(verifyTicket("no-dot-here", 1001)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyTicket("", 1001)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("nonce guard", () => {
  it("accepts a jti once and refuses the replay", () => {
    const guard = createNonceGuard();
    expect(guard.accept("jti-1", 5000, 1000)).toBe(true);
    expect(guard.accept("jti-1", 5000, 1001)).toBe(false);
  });

  it("forgets nonces once they are past their expiry", () => {
    const guard = createNonceGuard();
    guard.accept("jti-1", 2000, 1000);
    // Sweeping at 3000 drops the entry; a ticket that old would fail
    // verifyTicket anyway, so re-accepting it here is not a replay window.
    expect(guard.accept("jti-2", 9000, 3000)).toBe(true);
    expect(guard.accept("jti-1", 9000, 3000)).toBe(true);
  });
});

describe("parseClientMessage", () => {
  it("parses hello and resize", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ t: "hello", ticket: "abc", cols: 80, rows: 24 })
      )
    ).toEqual({ t: "hello", ticket: "abc", cols: 80, rows: 24 });
    expect(
      parseClientMessage(JSON.stringify({ t: "resize", cols: 100, rows: 40 }))
    ).toEqual({ t: "resize", cols: 100, rows: 40 });
  });

  it("returns null for junk, unknown types, and out-of-range geometry", () => {
    expect(parseClientMessage("{{{")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "spawn" }))).toBeNull();
    expect(
      parseClientMessage(JSON.stringify({ t: "resize", cols: 0, rows: 24 }))
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({ t: "resize", cols: 99_999, rows: 24 })
      )
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/terminal-protocol.test.ts`
Expected: FAIL — `Cannot find module '@/lib/terminal/protocol'`

- [ ] **Step 3: Write the implementation**

Create `lib/terminal/protocol.ts`:

```ts
import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// Wire protocol between the browser and the terminal sidecar.
//
// Text frames carry the JSON control messages below; BINARY frames carry raw
// tty bytes in both directions. The WebSocket frame type is the discriminator,
// so stdin/stdout need no envelope and no length prefix.
//
// This module deliberately does NOT import "server-only": the client component
// imports the message types from here, and while `import type` is erased, a
// guard that only holds by convention is worth less than one that can't be
// broken. Everything here is pure — no db, no fs, no sockets.

export type ClientMessage =
  | {
      t: "hello";
      ticket: string;
      cols: number;
      rows: number;
      // Present when reattaching to a session that outlived its socket.
      sessionId?: string;
    }
  | { t: "resize"; cols: number; rows: number };

export type ServerMessage =
  | { t: "ready"; sessionId: string }
  | { t: "exit"; code: number | null; signal: string | null }
  | { t: "error"; message: string };

export type TicketPayload = {
  v: 1;
  // Actor. Also the reattach ownership check — a session may only be resumed
  // by the user who opened it.
  uid: string;
  // Target server row id.
  sid: string;
  // Directory to cd into on open. ALREADY confined against the server's
  // sftpRoot by the mint side; the sidecar treats it as authorized input.
  // Empty string means "wherever the login shell lands".
  cwd: string;
  exp: number;
  // Replay nonce. Single-use within its validity window.
  jti: string;
};

// Long enough for a page load and a WebSocket handshake, short enough that a
// ticket captured from a log or a debugger is worthless by the time it's read.
export const TICKET_TTL_MS = 30_000;

// Geometry bounds. xterm will never legitimately ask for anything outside this,
// and unbounded values reach ssh2's window-change packet.
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 1000;

const HKDF_INFO = "terminal-ticket-v1";

let cachedKey: Buffer | null = null;

// Derived from SECRETS_KEY rather than being its own env var: one secret to
// manage, and HKDF keeps the signing key cryptographically separate from the
// at-rest encryption key that lib/secrets.ts uses the master for.
function ticketKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.SECRETS_KEY;
  if (!raw) {
    throw new Error(
      "SECRETS_KEY is not set — required to sign terminal tickets"
    );
  }
  const master = Buffer.from(raw, "base64");
  if (master.length !== 32) {
    throw new Error(
      `SECRETS_KEY must decode to 32 bytes (got ${master.length})`
    );
  }
  cachedKey = Buffer.from(
    hkdfSync("sha256", master, Buffer.alloc(0), HKDF_INFO, 32)
  );
  return cachedKey;
}

function sign(body: string): string {
  return createHmac("sha256", ticketKey()).update(body).digest("base64url");
}

export function mintTicket(
  input: { uid: string; sid: string; cwd: string },
  now: number = Date.now()
): string {
  const payload: TicketPayload = {
    v: 1,
    uid: input.uid,
    sid: input.sid,
    cwd: input.cwd,
    exp: now + TICKET_TTL_MS,
    jti: randomBytes(16).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  return `${body}.${sign(body)}`;
}

export type VerifyResult =
  | { ok: true; payload: TicketPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

export function verifyTicket(
  ticket: string,
  now: number = Date.now()
): VerifyResult {
  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot === ticket.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const body = ticket.slice(0, dot);
  const mac = ticket.slice(dot + 1);

  // Signature first: never parse attacker-controlled JSON we haven't
  // authenticated.
  const expected = Buffer.from(sign(body));
  const provided = Buffer.from(mac);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload: TicketPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    payload?.v !== 1 ||
    typeof payload.uid !== "string" ||
    typeof payload.sid !== "string" ||
    typeof payload.cwd !== "string" ||
    typeof payload.exp !== "number" ||
    typeof payload.jti !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (now >= payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

// Single-use enforcement for tickets. A valid ticket is still only good once,
// so a replay inside the 30s window is refused. Entries are swept on access
// rather than on a timer — the map only ever holds nonces from the last 30s.
export function createNonceGuard(): {
  accept(jti: string, exp: number, now?: number): boolean;
} {
  const seen = new Map<string, number>();
  return {
    accept(jti: string, exp: number, now: number = Date.now()): boolean {
      for (const [key, expiry] of seen) {
        if (expiry <= now) seen.delete(key);
      }
      if (seen.has(jti)) return false;
      seen.set(jti, exp);
      return true;
    },
  };
}

function isDimension(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_DIMENSION &&
    value <= MAX_DIMENSION
  );
}

// Parse a text frame into a control message. Returns null for anything this
// side does not accept — the caller closes the socket rather than guessing.
export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const msg = parsed as Record<string, unknown>;

  if (msg.t === "hello") {
    if (typeof msg.ticket !== "string" || msg.ticket.length === 0) return null;
    if (!isDimension(msg.cols) || !isDimension(msg.rows)) return null;
    if (msg.sessionId !== undefined && typeof msg.sessionId !== "string") {
      return null;
    }
    return {
      t: "hello",
      ticket: msg.ticket,
      cols: msg.cols,
      rows: msg.rows,
      ...(msg.sessionId === undefined ? {} : { sessionId: msg.sessionId }),
    };
  }

  if (msg.t === "resize") {
    if (!isDimension(msg.cols) || !isDimension(msg.rows)) return null;
    return { t: "resize", cols: msg.cols, rows: msg.rows };
  }

  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/terminal-protocol.test.ts`
Expected: PASS, 9 tests.

If `hkdfSync` throws `not implemented` under Bun, replace the body of `ticketKey()`'s derivation line with:

```ts
  cachedKey = createHmac("sha256", master).update(HKDF_INFO).digest();
```

and note the substitution in the commit body. Everything else is unchanged.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bun run check
bun run typecheck
git add lib/terminal/protocol.ts tests/terminal-protocol.test.ts
git commit -m "feat(terminal): add ticket protocol and wire message types"
```

---

### Task 2: Session registry

Everything about a live shell's lifetime, with no knowledge of sockets or SSH. Timers and the clock are injected so the tests run in microseconds instead of waiting out a 60-second grace period.

**Files:**
- Create: `lib/terminal/session.ts`
- Test: `tests/terminal-session.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (deliberately independent).
- Produces:
  - `class RingBuffer { constructor(capacity: number); push(chunk: Uint8Array): void; read(): Uint8Array; get size(): number }`
  - `type ShellHandle = { write(data: Uint8Array): void; resize(cols: number, rows: number): void; close(): void; setFlowing(flowing: boolean): void }`
  - `type Sink = { send(data: Uint8Array | string): void; close(): void; bufferedAmount(): number }`
  - `type Session = { id: string; userId: string; serverId: string; shell: ShellHandle; sink: Sink | null; openedAt: number }`
  - `type SessionLimits` and `DEFAULT_LIMITS`
  - `class SessionRegistry` with `create`, `attach`, `detach`, `onOutput`, `checkFlow`, `touch`, `destroy`, `destroyAll`, `onDestroy`, `get`, `countFor`, `size`
  - `class TooManySessionsError extends Error`

- [ ] **Step 1: Write the failing test**

Create `tests/terminal-session.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_LIMITS,
  RingBuffer,
  SessionRegistry,
  type ShellHandle,
  type Sink,
  TooManySessionsError,
} from "@/lib/terminal/session";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function fakeShell(): ShellHandle & {
  written: string[];
  closed: boolean;
  flowing: boolean;
} {
  return {
    written: [],
    closed: false,
    flowing: true,
    write(data) {
      this.written.push(text(data));
    },
    resize() {},
    close() {
      this.closed = true;
    },
    setFlowing(flowing) {
      this.flowing = flowing;
    },
  };
}

// `buffered` is writable so a test can simulate a socket whose send buffer is
// full — otherwise the flow-control thresholds are never reached and the
// pause/resume logic goes untested.
function fakeSink(): Sink & {
  sent: (string | Uint8Array)[];
  closed: boolean;
  buffered: number;
} {
  return {
    sent: [],
    closed: false,
    buffered: 0,
    send(data) {
      this.sent.push(data);
    },
    close() {
      this.closed = true;
    },
    bufferedAmount() {
      return this.buffered;
    },
  };
}

// A scheduler the test drives by hand: nothing fires until advance() is called.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

function makeRegistry(clock = fakeClock(), limits = {}) {
  const registry = new SessionRegistry({
    limits: { ...DEFAULT_LIMITS, ...limits },
    now: clock.now,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
  });
  return { registry, clock };
}

describe("RingBuffer", () => {
  it("returns everything pushed while under capacity", () => {
    const ring = new RingBuffer(64);
    ring.push(bytes("hello "));
    ring.push(bytes("world"));
    expect(text(ring.read())).toBe("hello world");
  });

  it("drops the oldest bytes once capacity is exceeded", () => {
    const ring = new RingBuffer(8);
    ring.push(bytes("abcdef"));
    ring.push(bytes("ghijkl"));
    expect(text(ring.read())).toBe("efghijkl");
    expect(ring.size).toBe(8);
  });

  it("keeps only the tail of a single oversized chunk", () => {
    const ring = new RingBuffer(4);
    ring.push(bytes("abcdefgh"));
    expect(text(ring.read())).toBe("efgh");
  });
});

describe("SessionRegistry", () => {
  it("creates a session, replays nothing, and reports it by id", () => {
    const { registry } = makeRegistry();
    const sink = fakeSink();
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell: fakeShell(),
      sink,
    });
    expect(registry.get(session.id)).toBe(session);
    expect(registry.countFor("u1")).toBe(1);
  });

  it("refuses to exceed the per-user session cap", () => {
    const { registry } = makeRegistry(fakeClock(), { maxPerUser: 2 });
    const open = () =>
      registry.create({
        userId: "u1",
        serverId: "s1",
        shell: fakeShell(),
        sink: fakeSink(),
      });
    open();
    open();
    expect(open).toThrow(TooManySessionsError);
    // A different user is unaffected.
    expect(() =>
      registry.create({
        userId: "u2",
        serverId: "s1",
        shell: fakeShell(),
        sink: fakeSink(),
      })
    ).not.toThrow();
  });

  it("buffers output while detached and replays it on reattach", () => {
    const { registry } = makeRegistry();
    const first = fakeSink();
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell: fakeShell(),
      sink: first,
    });

    registry.onOutput(session, bytes("live"));
    expect(first.sent).toHaveLength(1);

    registry.detach(session);
    registry.onOutput(session, bytes("while-away"));
    expect(first.sent).toHaveLength(1);

    const second = fakeSink();
    const resumed = registry.attach(session.id, "u1", "s1", second);
    expect(resumed).toBe(session);
    expect(text(second.sent[0] as Uint8Array)).toBe("livewhile-away");
  });

  it("refuses to reattach a session belonging to another user or server", () => {
    const { registry } = makeRegistry();
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell: fakeShell(),
      sink: fakeSink(),
    });
    registry.detach(session);
    expect(registry.attach(session.id, "u2", "s1", fakeSink())).toBeNull();
    expect(registry.attach(session.id, "u1", "s2", fakeSink())).toBeNull();
    expect(registry.attach("no-such-session", "u1", "s1", fakeSink())).toBeNull();
  });

  it("destroys a detached session once the grace period elapses", () => {
    const { registry, clock } = makeRegistry();
    const shell = fakeShell();
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell,
      sink: fakeSink(),
    });

    registry.detach(session);
    clock.advance(DEFAULT_LIMITS.graceMs - 1);
    expect(registry.get(session.id)).toBe(session);

    clock.advance(2);
    expect(registry.get(session.id)).toBeUndefined();
    expect(shell.closed).toBe(true);
    expect(registry.countFor("u1")).toBe(0);
  });

  it("cancels the grace timer when the session is reattached in time", () => {
    const { registry, clock } = makeRegistry();
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell: fakeShell(),
      sink: fakeSink(),
    });
    registry.detach(session);
    clock.advance(DEFAULT_LIMITS.graceMs - 1);
    registry.attach(session.id, "u1", "s1", fakeSink());
    clock.advance(DEFAULT_LIMITS.graceMs);
    expect(registry.get(session.id)).toBe(session);
  });

  it("kills an idle session and resets the idle clock on input", () => {
    const { registry, clock } = makeRegistry(fakeClock(), { idleMs: 1000 });
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell: fakeShell(),
      sink: fakeSink(),
    });

    clock.advance(900);
    registry.touch(session);
    clock.advance(900);
    expect(registry.get(session.id)).toBe(session);

    clock.advance(200);
    expect(registry.get(session.id)).toBeUndefined();
  });

  it("kills a session at the absolute lifetime cap even while busy", () => {
    const { registry, clock } = makeRegistry(fakeClock(), {
      idleMs: 10_000,
      maxLifetimeMs: 5000,
    });
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell: fakeShell(),
      sink: fakeSink(),
    });
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      registry.touch(session);
    }
    expect(registry.get(session.id)).toBeUndefined();
  });

  it("notifies the destroy listener exactly once per session", () => {
    const { registry, clock } = makeRegistry();
    const destroyed: string[] = [];
    registry.onDestroy((s, reason) => destroyed.push(`${s.id}:${reason}`));
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell: fakeShell(),
      sink: fakeSink(),
    });
    registry.destroy(session, "exit");
    registry.destroy(session, "grace");
    clock.advance(DEFAULT_LIMITS.maxLifetimeMs);
    expect(destroyed).toEqual([`${session.id}:exit`]);
  });

  it("pauses the shell when the socket buffer exceeds the cap", () => {
    const { registry } = makeRegistry();
    const shell = fakeShell();
    const sink = fakeSink();
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell,
      sink,
    });

    sink.buffered = DEFAULT_LIMITS.pauseAboveBytes + 1;
    registry.onOutput(session, bytes("flood"));
    expect(shell.flowing).toBe(false);
  });

  it("resumes a paused shell once the socket drains", () => {
    // Regression: the resume check used to live only in onOutput, which stops
    // being called the moment the stream is paused — so a paused session could
    // never recover. checkFlow is the drain-side entry point.
    const { registry } = makeRegistry();
    const shell = fakeShell();
    const sink = fakeSink();
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell,
      sink,
    });

    sink.buffered = DEFAULT_LIMITS.pauseAboveBytes + 1;
    registry.onOutput(session, bytes("flood"));
    expect(shell.flowing).toBe(false);

    sink.buffered = DEFAULT_LIMITS.resumeBelowBytes - 1;
    registry.checkFlow(session);
    expect(shell.flowing).toBe(true);
  });

  it("holds the pause while the buffer sits between the two thresholds", () => {
    const { registry } = makeRegistry();
    const shell = fakeShell();
    const sink = fakeSink();
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell,
      sink,
    });

    sink.buffered = DEFAULT_LIMITS.pauseAboveBytes + 1;
    registry.onOutput(session, bytes("flood"));
    // Hysteresis: below the pause threshold but not yet below the resume one.
    sink.buffered = DEFAULT_LIMITS.resumeBelowBytes + 1;
    registry.checkFlow(session);
    expect(shell.flowing).toBe(false);
  });

  it("ignores flow checks on a detached or destroyed session", () => {
    const { registry } = makeRegistry();
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell: fakeShell(),
      sink: fakeSink(),
    });
    registry.detach(session);
    expect(() => registry.checkFlow(session)).not.toThrow();
    registry.destroy(session, "exit");
    expect(() => registry.checkFlow(session)).not.toThrow();
  });

  it("closes the displaced sink when a session is reattached over a live one", () => {
    const { registry } = makeRegistry();
    const first = fakeSink();
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell: fakeShell(),
      sink: first,
    });
    const second = fakeSink();
    registry.attach(session.id, "u1", "s1", second);
    expect(first.closed).toBe(true);
    expect(session.sink).toBe(second);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/terminal-session.test.ts`
Expected: FAIL — `Cannot find module '@/lib/terminal/session'`

- [ ] **Step 3: Write the implementation**

Create `lib/terminal/session.ts`:

```ts
import { randomUUID } from "node:crypto";

// Lifetime management for live shells. Knows nothing about WebSockets or SSH:
// it is handed a ShellHandle and a Sink, and owns only the rules — scrollback,
// grace period, idle/lifetime caps, per-user limits, backpressure.
//
// Timers and the clock are injected so the tests can drive a 60-second grace
// period in a microsecond, and so nothing here depends on a specific runtime.

// The remote shell channel, as this module needs it.
export type ShellHandle = {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
  // Backpressure: false pauses the remote stream, true resumes it.
  setFlowing(flowing: boolean): void;
};

// The browser connection, as this module needs it.
export type Sink = {
  send(data: Uint8Array | string): void;
  close(): void;
  bufferedAmount(): number;
};

export type SessionLimits = {
  graceMs: number;
  idleMs: number;
  maxLifetimeMs: number;
  maxPerUser: number;
  ringBytes: number;
  pauseAboveBytes: number;
  resumeBelowBytes: number;
};

export const DEFAULT_LIMITS: SessionLimits = {
  // Long enough to survive a reload or a wifi blip, short enough that an
  // abandoned root shell doesn't sit open for minutes.
  graceMs: 60_000,
  idleMs: 30 * 60_000,
  maxLifetimeMs: 8 * 60 * 60_000,
  maxPerUser: 4,
  ringBytes: 256 * 1024,
  // Without these, `cat` on a multi-GB file grows the process heap until it
  // dies — taking every other session on this sidecar with it.
  pauseAboveBytes: 1024 * 1024,
  resumeBelowBytes: 256 * 1024,
};

export type DestroyReason = "grace" | "idle" | "lifetime" | "exit" | "shutdown";

export class TooManySessionsError extends Error {
  constructor() {
    super("Too many terminal sessions for this user");
    this.name = "TooManySessionsError";
  }
}

// A byte-granular FIFO with a hard cap: the newest `capacity` bytes survive.
// Byte-granular rather than chunk-granular because a replay that starts
// mid-escape-sequence is no worse than one that starts mid-line, and dropping
// whole chunks would make the cap unpredictable.
export class RingBuffer {
  private chunks: Uint8Array[] = [];
  private total = 0;

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.total;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total > this.capacity) {
      const first = this.chunks[0];
      if (!first) break;
      const excess = this.total - this.capacity;
      if (first.length <= excess) {
        this.chunks.shift();
        this.total -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.total -= excess;
      }
    }
  }

  read(): Uint8Array {
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export type Session = {
  id: string;
  userId: string;
  serverId: string;
  shell: ShellHandle;
  // null while detached — the shell is alive but no browser is listening.
  sink: Sink | null;
  ring: RingBuffer;
  openedAt: number;
  flowing: boolean;
  graceTimer: unknown;
  idleTimer: unknown;
  lifetimeTimer: unknown;
  destroyed: boolean;
};

type Timer = unknown;

export type RegistryOptions = {
  limits?: SessionLimits;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
};

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly limits: SessionLimits;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private destroyListener:
    | ((session: Session, reason: DestroyReason) => void)
    | null = null;

  constructor(options: RegistryOptions = {}) {
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // An idle session must never hold the process open on shutdown.
        (t as { unref?: () => void }).unref?.();
        return t;
      });
    this.clearTimer =
      options.clearTimer ?? ((t) => clearTimeout(t as Parameters<typeof clearTimeout>[0]));
  }

  onDestroy(listener: (session: Session, reason: DestroyReason) => void): void {
    this.destroyListener = listener;
  }

  get size(): number {
    return this.sessions.size;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  countFor(userId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId) count++;
    }
    return count;
  }

  create(input: {
    userId: string;
    serverId: string;
    shell: ShellHandle;
    sink: Sink;
  }): Session {
    if (this.countFor(input.userId) >= this.limits.maxPerUser) {
      throw new TooManySessionsError();
    }
    const session: Session = {
      id: randomUUID(),
      userId: input.userId,
      serverId: input.serverId,
      shell: input.shell,
      sink: input.sink,
      ring: new RingBuffer(this.limits.ringBytes),
      openedAt: this.now(),
      flowing: true,
      graceTimer: null,
      idleTimer: null,
      lifetimeTimer: null,
      destroyed: false,
    };
    this.sessions.set(session.id, session);
    this.armIdle(session);
    session.lifetimeTimer = this.setTimer(
      () => this.destroy(session, "lifetime"),
      this.limits.maxLifetimeMs
    );
    return session;
  }

  // Resume a session whose socket died. Ownership is checked on BOTH the user
  // and the server: a ticket for a different server must never hand back
  // someone else's shell, and a mismatch is indistinguishable from "gone" to
  // the caller on purpose.
  attach(
    sessionId: string,
    userId: string,
    serverId: string,
    sink: Sink
  ): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.userId !== userId || session.serverId !== serverId) return null;

    this.clearTimer(session.graceTimer);
    session.graceTimer = null;

    // Assign BEFORE closing the displaced sink. Bun dispatches a socket's
    // close handler synchronously from inside `close()`, and that handler asks
    // "am I still this session's sink?" to decide whether to detach. Closing
    // first would have it run while `session.sink` was still the OLD sink — it
    // would answer yes, detach a live session, and arm a 60s grace timer that
    // nothing clears. Sixty seconds later the shell dies under a user who is
    // actively typing.
    const displaced = session.sink;
    session.sink = sink;
    if (displaced) {
      try {
        displaced.close();
      } catch {
        // Already gone.
      }
    }

    const backlog = session.ring.read();
    if (backlog.length > 0) sink.send(backlog);
    // The new socket starts with an empty buffer, so a stream paused against
    // the old one must be let go again.
    this.checkFlow(session);
    return session;
  }

  // The socket went away; keep the shell alive for the grace window.
  detach(session: Session): void {
    if (session.destroyed) return;
    session.sink = null;
    this.clearTimer(session.graceTimer);
    session.graceTimer = this.setTimer(
      () => this.destroy(session, "grace"),
      this.limits.graceMs
    );
  }

  // Output from the remote shell: forward it when attached, and always keep it
  // in the ring so a reattach can replay what was missed.
  onOutput(session: Session, chunk: Uint8Array): void {
    if (session.destroyed) return;
    session.ring.push(chunk);
    const sink = session.sink;
    if (!sink) return;
    sink.send(chunk);
    this.checkFlow(session);
  }

  // Re-evaluate flow control against the sink's CURRENT buffer.
  //
  // Public because `onOutput` alone cannot resume a paused stream: pausing is
  // what stops output arriving, so nothing would ever call back in. The socket
  // layer calls this from its drain event, which is the only moment the buffer
  // is known to have shrunk.
  checkFlow(session: Session): void {
    if (session.destroyed) return;
    const sink = session.sink;
    if (!sink) return;
    const buffered = sink.bufferedAmount();
    if (session.flowing && buffered > this.limits.pauseAboveBytes) {
      session.flowing = false;
      session.shell.setFlowing(false);
    } else if (!session.flowing && buffered < this.limits.resumeBelowBytes) {
      session.flowing = true;
      session.shell.setFlowing(true);
    }
  }

  // Called on every stdin byte: the user is present, so restart the idle clock.
  touch(session: Session): void {
    if (session.destroyed) return;
    this.armIdle(session);
  }

  destroy(session: Session, reason: DestroyReason): void {
    if (session.destroyed) return;
    session.destroyed = true;
    this.clearTimer(session.graceTimer);
    this.clearTimer(session.idleTimer);
    this.clearTimer(session.lifetimeTimer);
    this.sessions.delete(session.id);
    try {
      session.shell.close();
    } catch {
      // Already torn down.
    }
    try {
      session.sink?.close();
    } catch {
      // Socket already closed.
    }
    this.destroyListener?.(session, reason);
  }

  destroyAll(reason: DestroyReason = "shutdown"): void {
    for (const session of [...this.sessions.values()]) {
      this.destroy(session, reason);
    }
  }

  private armIdle(session: Session): void {
    this.clearTimer(session.idleTimer);
    session.idleTimer = this.setTimer(
      () => this.destroy(session, "idle"),
      this.limits.idleMs
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/terminal-session.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bun run check
bun run typecheck
git add lib/terminal/session.ts tests/terminal-session.test.ts
git commit -m "feat(terminal): add session registry with grace, idle and lifetime caps"
```

---

### Task 3: Ticket route

The only place that decides who may open a shell where. Splits into a pure resolver (tested) and a thin HTTP wrapper (not worth mocking Next's request plumbing for).

**Files:**
- Create: `lib/terminal/authorize.ts`
- Create: `app/api/terminal/ticket/route.ts`
- Test: `tests/terminal-authorize.test.ts`

**Interfaces:**
- Consumes: `mintTicket` from `lib/terminal/protocol`; `confineSftpPath`, `PathError` from `lib/explorer/path`.
- Produces:
  - `resolveTerminalCwd(sftpRoot: string, requested: string | undefined): { ok: true; cwd: string } | { ok: false }`
  - `POST /api/terminal/ticket` → `200 {"ticket": string}` / `400` / `403` / `404`

- [ ] **Step 1: Write the failing test**

Create `tests/terminal-authorize.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { resolveTerminalCwd } from "@/lib/terminal/authorize";

describe("resolveTerminalCwd", () => {
  it("returns an empty cwd when none was requested", () => {
    expect(resolveTerminalCwd("/", undefined)).toEqual({ ok: true, cwd: "" });
    expect(resolveTerminalCwd("/home/deploy", "")).toEqual({
      ok: true,
      cwd: "",
    });
  });

  it("confines a requested path under the server's sftp root", () => {
    expect(resolveTerminalCwd("/", "deployments/dplk-membership/")).toEqual({
      ok: true,
      cwd: "/deployments/dplk-membership",
    });
    expect(resolveTerminalCwd("/home/deploy", "app/")).toEqual({
      ok: true,
      cwd: "/home/deploy/app",
    });
  });

  it("rejects a traversal above the root instead of falling back to it", () => {
    expect(resolveTerminalCwd("/home/deploy", "../../etc")).toEqual({
      ok: false,
    });
  });

  it("rejects a cwd made unsafe by the server's own sftp root", () => {
    // sftpRoot is admin-configured and its validation permits quotes, so the
    // joined path can carry a metacharacter the requested path never had.
    expect(resolveTerminalCwd("/home/dep'loy", "app/")).toEqual({ ok: false });
    expect(resolveTerminalCwd("/srv\nevil", "app/")).toEqual({ ok: false });
  });

  it("rejects a path carrying shell metacharacters", () => {
    // The cwd is interpolated into a `cd '<path>'` line written to the pty, so
    // a single quote would break out of the quoting.
    expect(resolveTerminalCwd("/", "a'; rm -rf /; echo '")).toEqual({
      ok: false,
    });
    expect(resolveTerminalCwd("/", "a\nwhoami")).toEqual({ ok: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/terminal-authorize.test.ts`
Expected: FAIL — `Cannot find module '@/lib/terminal/authorize'`

- [ ] **Step 3: Write the implementation**

Create `lib/terminal/authorize.ts`:

```ts
import { confineSftpPath, PathError } from "@/lib/explorer/path";

// Characters that would end the single-quoted `cd '<path>'` line the sidecar
// writes to the pty, or start a second command. The quoting already holds for
// everything else, so this is a belt-and-braces check on the one byte that
// matters plus the newline that would submit a second line.
const UNSAFE_CWD = /['\n\r\0]/;

// Resolve the requested working directory against the server's configured sftp
// root. Runs on the mint side so the ticket the sidecar receives is already
// authorized — the sidecar never makes a path decision.
//
// A rejected path is a 400, deliberately, rather than a silent fall back to the
// root: "open a terminal here" quietly landing somewhere else is worse than an
// error, because the next command runs against the wrong directory.
export function resolveTerminalCwd(
  sftpRoot: string,
  requested: string | undefined
): { ok: true; cwd: string } | { ok: false } {
  if (!requested) return { ok: true, cwd: "" };
  if (UNSAFE_CWD.test(requested)) return { ok: false };
  try {
    const confined = confineSftpPath(sftpRoot, requested);
    // Explorer dir paths carry a trailing slash; `cd` does not care, but the
    // audit log and the ticket read better without it. Keep "/" intact.
    const cwd = confined.length > 1 ? confined.replace(/\/+$/, "") : confined;
    // The pre-check above covers the untrusted half of the input; this one
    // covers what actually ships. `sftpRoot` is admin-configured and its own
    // validation (lib/validation.ts) permits quotes and newlines, so the
    // joined result can carry a byte `requested` never contained.
    if (UNSAFE_CWD.test(cwd)) return { ok: false };
    return { ok: true, cwd };
  } catch (error) {
    if (error instanceof PathError) return { ok: false };
    throw error;
  }
}
```

Create `app/api/terminal/ticket/route.ts`:

```ts
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { getServerSession, isAdmin } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { resolveTerminalCwd } from "@/lib/terminal/authorize";
import { mintTicket } from "@/lib/terminal/protocol";

// Mints the short-lived credential the terminal sidecar accepts. This route is
// the single authorization decision for the feature: the sidecar only checks a
// signature, so anything it must not do has to be refused here.
//
// Node runtime: lib/db and lib/secrets are server-only and Edge can't run them.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  serverId: z.uuid(),
  cwd: z.string().max(4096).optional(),
});

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  // Admin-only, matching the file explorer. Checked here as well as on the
  // page, because this route is directly callable.
  if (!session || !isAdmin(session)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return new NextResponse("Invalid input", { status: 400 });
  }

  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, parsed.data.serverId))
    .limit(1);
  if (!server) return new NextResponse("Not found", { status: 404 });

  const cwd = resolveTerminalCwd(server.sftpRoot, parsed.data.cwd);
  if (!cwd.ok) {
    await recordActivity({
      actorId: session.user.id,
      action: "terminal.denied",
      entityType: "server",
      entityId: server.id,
      data: { server: server.name, reason: "cwd" },
    });
    return new NextResponse("Invalid path", { status: 400 });
  }

  const ticket = mintTicket({
    uid: session.user.id,
    sid: server.id,
    cwd: cwd.cwd,
  });
  // No-store: a ticket is single-use and valid for 30s; a cached copy is only
  // ever a liability.
  return NextResponse.json(
    { ticket },
    { headers: { "Cache-Control": "no-store" } }
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/terminal-authorize.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bun run check
bun run typecheck
git add lib/terminal/authorize.ts app/api/terminal/ticket/route.ts tests/terminal-authorize.test.ts
git commit -m "feat(terminal): add admin-gated ticket route with confined cwd"
```

---

### Task 4: Sidecar WebSocket server

Splits into handlers (dependency-injected, integration-tested against a real in-process sshd) and a `main.ts` entry that wires the database in and calls `Bun.serve`.

**Files:**
- Create: `lib/terminal/ssh-shell.ts`
- Create: `lib/terminal/server.ts`
- Create: `lib/terminal/main.ts`
- Modify: `package.json` (add the `terminal` script)
- Test: `tests/terminal-server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces:
  - `openSshShell(creds, opts): Promise<ShellHandle & { onData, onExit }>` from `ssh-shell.ts`
  - `createTerminalHandlers(deps: TerminalDeps): { fetch; websocket; registry }` from `server.ts`
  - `type TerminalDeps = { loadServer(id): Promise<TerminalTarget | null>; openShell(target, opts): Promise<ShellSession>; audit(event): void; allowedOrigin: string | null; registry?: SessionRegistry }`

- [ ] **Step 1: Write the failing integration test**

Create `tests/terminal-server.test.ts`:

```ts
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import ssh2 from "ssh2";
import { createTerminalHandlers } from "@/lib/terminal/server";
import { openSshShell } from "@/lib/terminal/ssh-shell";
import { mintTicket } from "@/lib/terminal/protocol";

// A throwaway sshd in this process. It accepts one password and answers a shell
// request with a tiny echo loop — enough to prove the plumbing (open, data,
// resize, exit) without needing a real machine.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

let sshd: ssh2.Server;
let sshdPort = 0;
const windowChanges: { cols: number; rows: number }[] = [];

beforeAll(async () => {
  process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");

  sshd = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.password === "correct-horse") {
        ctx.accept();
      } else {
        ctx.reject();
      }
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (a) => a?.());
        session.on("window-change", (a, _reject, info) => {
          windowChanges.push({ cols: info.cols, rows: info.rows });
          a?.();
        });
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.write("banner\r\n");
          stream.on("data", (chunk: Buffer) => {
            const line = chunk.toString("utf8");
            if (line.includes("quit")) {
              stream.exit(0);
              stream.end();
              return;
            }
            stream.write(`echo:${line}`);
          });
        });
      });
    });
  });

  await new Promise<void>((resolve) => {
    sshd.listen(0, "127.0.0.1", () => {
      sshdPort = (sshd.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(() => {
  sshd.close();
});

function handlers() {
  return createTerminalHandlers({
    allowedOrigin: null,
    loadServer: async (id) =>
      id === "server-1"
        ? {
            id: "server-1",
            name: "Test",
            host: "127.0.0.1",
            port: sshdPort,
            username: "tester",
            password: "correct-horse",
          }
        : null,
    openShell: (target, opts) => openSshShell(target, opts),
    audit: () => {},
  });
}

// Drive a real WebSocket client against a real Bun.serve instance: the message
// loop, the frame-type discrimination, and the ssh2 channel are exactly what
// ships.
async function withServer<T>(
  run: (url: string) => Promise<T>
): Promise<T> {
  const { fetch, websocket, registry } = handlers();
  const server = Bun.serve({ port: 0, fetch, websocket });
  try {
    return await run(`ws://127.0.0.1:${server.port}/ws/terminal`);
  } finally {
    registry.destroyAll();
    server.stop(true);
  }
}

function connect(url: string) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const control: Record<string, unknown>[] = [];
  let output = "";
  const waiters: (() => void)[] = [];
  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      control.push(JSON.parse(event.data));
    } else {
      output += new TextDecoder().decode(new Uint8Array(event.data));
    }
    for (const w of waiters.splice(0)) w();
  };
  const open = new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });
  return {
    ws,
    control,
    open,
    output: () => output,
    async until(predicate: () => boolean, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 25);
        });
      }
    },
  };
}

describe("terminal sidecar", () => {
  it("opens a shell, echoes stdin, and reports the session id", async () => {
    await withServer(async (url) => {
      const client = connect(url);
      await client.open;
      client.ws.send(
        JSON.stringify({
          t: "hello",
          ticket: mintTicket({ uid: "u1", sid: "server-1", cwd: "" }),
          cols: 80,
          rows: 24,
        })
      );
      await client.until(() => client.control.some((m) => m.t === "ready"));
      await client.until(() => client.output().includes("banner"));

      client.ws.send(new TextEncoder().encode("hello-there"));
      await client.until(() => client.output().includes("echo:hello-there"));
      client.ws.close();
    });
  });

  it("forwards a resize to the remote pty", async () => {
    await withServer(async (url) => {
      const client = connect(url);
      await client.open;
      client.ws.send(
        JSON.stringify({
          t: "hello",
          ticket: mintTicket({ uid: "u1", sid: "server-1", cwd: "" }),
          cols: 80,
          rows: 24,
        })
      );
      await client.until(() => client.control.some((m) => m.t === "ready"));
      windowChanges.length = 0;
      client.ws.send(JSON.stringify({ t: "resize", cols: 120, rows: 40 }));
      await client.until(() => windowChanges.length > 0);
      expect(windowChanges[0]).toEqual({ cols: 120, rows: 40 });
      client.ws.close();
    });
  });

  it("reattaches after a socket drop and replays what was missed", async () => {
    await withServer(async (url) => {
      const first = connect(url);
      await first.open;
      first.ws.send(
        JSON.stringify({
          t: "hello",
          ticket: mintTicket({ uid: "u1", sid: "server-1", cwd: "" }),
          cols: 80,
          rows: 24,
        })
      );
      await first.until(() => first.control.some((m) => m.t === "ready"));
      const ready = first.control.find((m) => m.t === "ready") as {
        sessionId: string;
      };
      await first.until(() => first.output().includes("banner"));
      first.ws.close();

      const second = connect(url);
      await second.open;
      second.ws.send(
        JSON.stringify({
          t: "hello",
          ticket: mintTicket({ uid: "u1", sid: "server-1", cwd: "" }),
          cols: 80,
          rows: 24,
          sessionId: ready.sessionId,
        })
      );
      await second.until(() => second.output().includes("banner"));
      const resumed = second.control.find((m) => m.t === "ready") as {
        sessionId: string;
      };
      expect(resumed.sessionId).toBe(ready.sessionId);
      second.ws.close();
    });
  });

  it("refuses a replayed ticket", async () => {
    await withServer(async (url) => {
      const ticket = mintTicket({ uid: "u1", sid: "server-1", cwd: "" });
      const first = connect(url);
      await first.open;
      first.ws.send(
        JSON.stringify({ t: "hello", ticket, cols: 80, rows: 24 })
      );
      await first.until(() => first.control.some((m) => m.t === "ready"));

      const second = connect(url);
      await second.open;
      second.ws.send(
        JSON.stringify({ t: "hello", ticket, cols: 80, rows: 24 })
      );
      await second.until(() => second.control.some((m) => m.t === "error"));
      first.ws.close();
      second.ws.close();
    });
  });

  it("refuses an expired ticket and an unknown server", async () => {
    await withServer(async (url) => {
      const stale = connect(url);
      await stale.open;
      stale.ws.send(
        JSON.stringify({
          t: "hello",
          ticket: mintTicket({ uid: "u1", sid: "server-1", cwd: "" }, 1000),
          cols: 80,
          rows: 24,
        })
      );
      await stale.until(() => stale.control.some((m) => m.t === "error"));

      const missing = connect(url);
      await missing.open;
      missing.ws.send(
        JSON.stringify({
          t: "hello",
          ticket: mintTicket({ uid: "u1", sid: "nope", cwd: "" }),
          cols: 80,
          rows: 24,
        })
      );
      await missing.until(() => missing.control.some((m) => m.t === "error"));
      stale.ws.close();
      missing.ws.close();
    });
  });

  it("propagates remote exit to the client", async () => {
    await withServer(async (url) => {
      const client = connect(url);
      await client.open;
      client.ws.send(
        JSON.stringify({
          t: "hello",
          ticket: mintTicket({ uid: "u1", sid: "server-1", cwd: "" }),
          cols: 80,
          rows: 24,
        })
      );
      await client.until(() => client.control.some((m) => m.t === "ready"));
      client.ws.send(new TextEncoder().encode("quit"));
      await client.until(() => client.control.some((m) => m.t === "exit"));
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/terminal-server.test.ts`
Expected: FAIL — `Cannot find module '@/lib/terminal/server'`

- [ ] **Step 3: Write the SSH shell adapter**

Create `lib/terminal/ssh-shell.ts`:

```ts
import { Client, type ClientChannel } from "ssh2";
import type { ShellHandle } from "@/lib/terminal/session";

// Adapts an ssh2 shell channel to the ShellHandle the session registry expects.
// Kept separate from server.ts so the registry, the message loop, and the SSH
// mechanics can each be reasoned about (and swapped in tests) on their own.

export type ShellTarget = {
  host: string;
  port?: number;
  username: string;
  password: string;
};

export type ShellOptions = {
  cols: number;
  rows: number;
  // Written as `cd '<cwd>'` on open. Already confined and metacharacter-checked
  // by lib/terminal/authorize — never accept an unvalidated value here.
  cwd?: string;
};

export type ShellSession = ShellHandle & {
  onData(cb: (chunk: Uint8Array) => void): void;
  onExit(cb: (info: { code: number | null; signal: string | null }) => void): void;
};

export function openSshShell(
  target: ShellTarget,
  options: ShellOptions
): Promise<ShellSession> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(error);
    };

    client.on("error", fail);

    client.on("ready", () => {
      client.shell(
        {
          term: "xterm-256color",
          cols: options.cols,
          rows: options.rows,
          width: options.cols * 8,
          height: options.rows * 16,
        },
        (err: Error | undefined, stream: ClientChannel) => {
          if (err) {
            fail(err);
            return;
          }
          settled = true;

          if (options.cwd) {
            // Single quotes are safe: authorize.ts rejects any cwd containing
            // one, along with newlines.
            stream.write(`cd '${options.cwd}'\n`);
          }

          const handle: ShellSession = {
            write(data) {
              stream.write(Buffer.from(data));
            },
            resize(cols, rows) {
              stream.setWindow(rows, cols, rows * 16, cols * 8);
            },
            close() {
              try {
                stream.end();
              } catch {
                // Channel already gone.
              }
              client.end();
            },
            setFlowing(flowing) {
              // stderr as well: on a server that splits it from stdout, an
              // unpaused stderr walks straight past the 1 MB threshold that
              // exists to stop an unbounded write buffer.
              if (flowing) {
                stream.resume();
                stream.stderr?.resume();
              } else {
                stream.pause();
                stream.stderr?.pause();
              }
            },
            onData(cb) {
              stream.on("data", (chunk: Buffer) => cb(new Uint8Array(chunk)));
              // stderr on a pty channel is normally folded into stdout, but a
              // server that splits them must not silently drop the second half.
              stream.stderr?.on("data", (chunk: Buffer) =>
                cb(new Uint8Array(chunk))
              );
            },
            onExit(cb) {
              let reported = false;
              const report = (
                code: number | null,
                signal: string | null
              ) => {
                if (reported) return;
                reported = true;
                cb({ code, signal });
                client.end();
              };
              stream.on("exit", (code: number | null, signal?: string) =>
                report(code, signal ?? null)
              );
              stream.on("close", () => report(null, null));
              client.on("close", () => report(null, null));
            },
          };
          resolve(handle);
        }
      );
    });

    client.connect({
      host: target.host,
      port: target.port ?? 22,
      username: target.username,
      password: target.password,
      // Fail fast on an unreachable host rather than hanging the browser's
      // "connecting…" state for 20s.
      readyTimeout: 8000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
    });
  });
}
```

- [ ] **Step 4: Write the handlers**

Create `lib/terminal/server.ts`:

```ts
import type { ServerWebSocket } from "bun";
import {
  createNonceGuard,
  parseClientMessage,
  type ServerMessage,
  verifyTicket,
} from "@/lib/terminal/protocol";
import type { ShellOptions, ShellSession, ShellTarget } from "@/lib/terminal/ssh-shell";
import {
  type DestroyReason,
  type Session,
  SessionRegistry,
  type Sink,
  TooManySessionsError,
} from "@/lib/terminal/session";

// The socket side of the terminal sidecar: verify, open, pump bytes. Every
// dependency that touches the world (database, SSH, audit log) is injected, so
// this module can be driven end-to-end in a test against a throwaway sshd.

export type TerminalTarget = ShellTarget & { id: string; name: string };

export type AuditEvent =
  | { kind: "open"; userId: string; target: TerminalTarget }
  | {
      kind: "close";
      userId: string;
      target: TerminalTarget;
      durationMs: number;
      reason: DestroyReason;
    }
  // `serverId` is null when the ticket itself could not be verified: there is
  // no trustworthy server id to attribute the attempt to, and the audit sink
  // writes this into a uuid column that rejects an empty string.
  | {
      kind: "denied";
      userId: string | null;
      serverId: string | null;
      reason: string;
    };

export type TerminalDeps = {
  loadServer(serverId: string): Promise<TerminalTarget | null>;
  openShell(target: TerminalTarget, options: ShellOptions): Promise<ShellSession>;
  audit(event: AuditEvent): void;
  // Exact origin the browser must send, or null to skip the check (tests, and
  // deployments where the app URL isn't known to the sidecar).
  allowedOrigin: string | null;
  registry?: SessionRegistry;
};

type SocketData = {
  session: Session | null;
  target: TerminalTarget | null;
  userId: string | null;
  // This socket's own sink, so the close handler can tell "I am still the
  // session's connection" from "a newer socket displaced me".
  sink: Sink | null;
  // Guards against a second hello on the same socket.
  greeted: boolean;
};

type Socket = ServerWebSocket<SocketData>;

function send(ws: Socket, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

// Same, but to a session's CURRENT sink rather than a specific socket. Typed
// against ServerMessage for the same reason `send` is: a hand-rolled
// JSON.stringify at the call site would not be checked against the protocol.
function sendTo(sink: Sink, message: ServerMessage): void {
  sink.send(JSON.stringify(message));
}

function fail(ws: Socket, message: string): void {
  send(ws, { t: "error", message });
  ws.close(1008, message);
}

export function createTerminalHandlers(deps: TerminalDeps) {
  const registry = deps.registry ?? new SessionRegistry();
  const nonces = createNonceGuard();
  // Session id -> what the audit log needs when it ends. Held here rather than
  // on the Session so the registry stays free of app concerns.
  const audited = new Map<string, { userId: string; target: TerminalTarget }>();

  registry.onDestroy((session, reason) => {
    const record = audited.get(session.id);
    audited.delete(session.id);
    if (!record) return;
    deps.audit({
      kind: "close",
      userId: record.userId,
      target: record.target,
      durationMs: Date.now() - session.openedAt,
      reason,
    });
  });

  async function onHello(
    ws: Socket,
    msg: Extract<ReturnType<typeof parseClientMessage>, { t: "hello" }>
  ): Promise<void> {
    const verified = verifyTicket(msg.ticket);
    if (!verified.ok) {
      // Audited without an actor: an unverifiable ticket has no trustworthy
      // uid to attribute it to, but a forged or expired ticket arriving at
      // this port is the most security-relevant denial there is.
      deps.audit({
        kind: "denied",
        userId: null,
        serverId: null,
        reason: `ticket-${verified.reason}`,
      });
      fail(ws, `Ticket ${verified.reason}`);
      return;
    }
    const { uid, sid, cwd, jti, exp } = verified.payload;

    // A ticket is good once. Without this, a ticket captured in flight could
    // open a second shell inside its 30s window.
    if (!nonces.accept(jti, exp)) {
      deps.audit({ kind: "denied", userId: uid, serverId: sid, reason: "replay" });
      fail(ws, "Ticket already used");
      return;
    }

    const target = await deps.loadServer(sid);
    if (!target) {
      deps.audit({ kind: "denied", userId: uid, serverId: sid, reason: "unknown-server" });
      fail(ws, "Server not found");
      return;
    }

    ws.data.userId = uid;
    ws.data.target = target;

    const sink: Sink = {
      send: (data: Uint8Array | string) => {
        ws.send(data);
      },
      close: () => ws.close(1000, "session ended"),
      bufferedAmount: () => ws.getBufferedAmount(),
    };
    ws.data.sink = sink;

    // Reattach path: an existing session whose socket died inside the grace
    // window. Ownership is checked by the registry against both ids.
    if (msg.sessionId) {
      const resumed = registry.attach(msg.sessionId, uid, sid, sink);
      if (resumed) {
        // Same hole as on the fresh path: a client that left during the
        // `loadServer` await never detached, because it had no session when it
        // closed. Attaching would bind a live shell to a dead socket AND clear
        // its grace timer, leaving nothing but the 30-minute idle reaper.
        if (ws.readyState !== WebSocket.OPEN) {
          registry.detach(resumed);
          return;
        }
        ws.data.session = resumed;
        resumed.shell.resize(msg.cols, msg.rows);
        send(ws, { t: "ready", sessionId: resumed.id });
        return;
      }
      // `attach` only returns null for a session that is gone or not ours,
      // and the reattach branch is entered only when it is neither — so this
      // is unreachable. Assert it rather than falling through: the fresh-open
      // path below would send a SECOND `ready` with a different session id.
      fail(ws, "Session could not be resumed");
      return;
    }

    let shell: ShellSession;
    try {
      shell = await deps.openShell(target, {
        cols: msg.cols,
        rows: msg.rows,
        ...(cwd ? { cwd } : {}),
      });
    } catch (error) {
      deps.audit({ kind: "denied", userId: uid, serverId: sid, reason: "ssh-failed" });
      fail(ws, error instanceof Error ? error.message : "SSH connection failed");
      return;
    }

    let session: Session;
    try {
      session = registry.create({ userId: uid, serverId: sid, shell, sink });
    } catch (error) {
      shell.close();
      if (error instanceof TooManySessionsError) {
        fail(ws, "Too many open terminals");
        return;
      }
      throw error;
    }

    // The SSH handshake can take seconds; a client that gave up in the
    // meantime never triggers the close handler's detach path, because it had
    // no session to detach when it closed. Without this the shell would sit
    // attached to a dead socket — no grace timer, just the 30-minute idle
    // reaper — holding one of the user's four slots and a live root shell.
    if (ws.readyState !== WebSocket.OPEN) {
      registry.destroy(session, "exit");
      return;
    }

    shell.onData((chunk) => registry.onOutput(session, chunk));
    shell.onExit((info) => {
      // Through `session.sink`, not the captured `ws`: after a reattach the
      // session's connection is a different socket, and writing the exit frame
      // to the old one drops it silently — the user sees a disconnect instead
      // of a clean exit, and loses the exit code.
      const sink = session.sink;
      if (sink) sendTo(sink, { t: "exit", ...info });
      registry.destroy(session, "exit");
    });

    ws.data.session = session;
    audited.set(session.id, { userId: uid, target });
    deps.audit({ kind: "open", userId: uid, target });
    send(ws, { t: "ready", sessionId: session.id });
  }

  return {
    registry,

    fetch(req: Request, server: { upgrade(req: Request, opts: { data: SocketData }): boolean }) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return new Response("ok");

      // A cross-origin page must not be able to open a socket with a stolen
      // cookie-free ticket, and the browser sends Origin on every upgrade.
      if (deps.allowedOrigin && req.headers.get("origin") !== deps.allowedOrigin) {
        return new Response("Forbidden", { status: 403 });
      }

      const upgraded = server.upgrade(req, {
          data: {
          session: null,
          target: null,
          userId: null,
          sink: null,
          greeted: false,
        },
      });
      return upgraded
        ? undefined
        : new Response("Expected a WebSocket upgrade", { status: 426 });
    },

    websocket: {
      // Frames above this are not legitimate terminal input.
      maxPayloadLength: 1024 * 1024,
      // Bun's default would close a socket that is only receiving output.
      idleTimeout: 120,

      message(ws: Socket, raw: string | Buffer) {
        // Binary frames are stdin; text frames are control messages.
        if (typeof raw !== "string") {
          const session = ws.data.session;
          if (!session) return;
          session.shell.write(new Uint8Array(raw));
          registry.touch(session);
          return;
        }

        const msg = parseClientMessage(raw);
        if (!msg) {
          fail(ws, "Malformed message");
          return;
        }

        if (msg.t === "hello") {
          if (ws.data.greeted) {
            fail(ws, "Already greeted");
            return;
          }
          ws.data.greeted = true;
          void onHello(ws, msg).catch((error: unknown) => {
            console.error("terminal hello failed:", error);
            fail(ws, "Internal error");
          });
          return;
        }

        if (msg.t === "resize") {
          ws.data.session?.shell.resize(msg.cols, msg.rows);
        }
      },

      // The socket's send buffer drained. This is the ONLY moment a paused
      // stream can learn it may resume: pausing stops output, which stops
      // onOutput, which is where the pause was decided.
      drain(ws: Socket) {
        const session = ws.data.session;
        if (session) registry.checkFlow(session);
      },

      close(ws: Socket) {
        const session = ws.data.session;
        if (!session) return;
        // Only the session's CURRENT socket may detach it. A reattach closes
        // the socket it displaced, and that close arrives here — without this
        // guard it would arm a 60s grace timer against a session that is very
        // much alive on its new connection.
        if (session.sink !== ws.data.sink) return;
        // Detach, don't destroy: the shell stays alive for the grace window so
        // a reload or a dropped connection can pick it back up.
        registry.detach(session);
      },
    },
  };
}
```

Create `lib/terminal/main.ts`:

```ts
import { eq } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/secrets";
import { createTerminalHandlers, type TerminalTarget } from "@/lib/terminal/server";
import { openSshShell } from "@/lib/terminal/ssh-shell";

// Entry point for the terminal sidecar. Bundled by the Dockerfile with
// `--conditions react-server`, which resolves the "server-only" guard in
// lib/db, lib/secrets and lib/activity to its empty stub — so this process
// reuses the app's data layer verbatim instead of duplicating it.

const port = Number(process.env.TERMINAL_WS_PORT ?? 3001);

// The browser's origin is the app's public URL, which the app already knows as
// BETTER_AUTH_URL. Unset (local dev over plain `bun run terminal`) skips the
// check rather than blocking every connection.
const allowedOrigin = process.env.BETTER_AUTH_URL
  ? new URL(process.env.BETTER_AUTH_URL).origin
  : null;

const { fetch, websocket, registry } = createTerminalHandlers({
  allowedOrigin,

  async loadServer(serverId: string): Promise<TerminalTarget | null> {
    const [row] = await db
      .select()
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      username: row.username,
      password: decryptSecret(row.password),
    };
  },

  openShell: (target, options) => openSshShell(target, options),

  // Who opened a shell where, and for how long. Never what was typed or
  // printed — see the design doc.
  audit(event) {
    if (event.kind === "open") {
      void recordActivity({
        actorId: event.userId,
        action: "terminal.open",
        entityType: "server",
        entityId: event.target.id,
        data: { server: event.target.name, host: event.target.host },
      });
      return;
    }
    if (event.kind === "close") {
      void recordActivity({
        actorId: event.userId,
        action: "terminal.close",
        entityType: "server",
        entityId: event.target.id,
        data: {
          server: event.target.name,
          seconds: Math.round(event.durationMs / 1000),
          reason: event.reason,
        },
      });
      return;
    }
    void recordActivity({
      actorId: event.userId,
      action: "terminal.denied",
      entityType: "server",
      // `entityId` lands in a uuid column: an unverifiable ticket names no
      // server, and undefined stores NULL where "" would be rejected outright
      // — and recordActivity swallows its own errors, so the row would simply
      // never appear.
      entityId: event.serverId ?? undefined,
      data: { reason: event.reason },
    });
  },
});

const server = Bun.serve({ port, hostname: "0.0.0.0", fetch, websocket });
console.log(`terminal sidecar listening on :${server.port}`);

// Close the shells rather than letting the container's SIGKILL orphan them.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    registry.destroyAll("shutdown");
    server.stop(true);
    process.exit(0);
  });
}
```

- [ ] **Step 5: Add the dev script**

In `package.json`, add to `"scripts"` after `"start"`:

```json
    "terminal": "bun run lib/terminal/main.ts",
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test tests/terminal-server.test.ts`
Expected: PASS, 6 tests.

If `server.upgrade` typing fights the handler signature, the fix is the `fetch(req, server)` parameter type — Bun's `Server` type from `import type { Server } from "bun"` — not a change to the runtime behavior.

- [ ] **Step 7: Run the whole suite, lint, typecheck, commit**

```bash
bun test
bun run check
bun run typecheck
git add lib/terminal/ssh-shell.ts lib/terminal/server.ts lib/terminal/main.ts tests/terminal-server.test.ts package.json
git commit -m "feat(terminal): add websocket sidecar with ssh shell channels"
```

---

### Task 5: Terminal client component

**Files:**
- Create: `components/server-terminal.tsx`
- Modify: `package.json` (xterm dependencies)

**Interfaces:**
- Consumes: `POST /api/terminal/ticket` (Task 3), the wire protocol (Task 1).
- Produces: `<ServerTerminal serverId={string} cwd={string | undefined} />`

- [ ] **Step 1: Install the terminal dependencies**

```bash
bun add @xterm/xterm @xterm/addon-fit @xterm/addon-webgl @xterm/addon-clipboard @xterm/addon-web-links @xterm/addon-unicode11
```

Expected at time of writing: `@xterm/xterm@6.0.0`, `addon-fit@0.11.0`, `addon-webgl@0.19.0`, `addon-clipboard@0.2.0`, `addon-web-links@0.12.0`, `addon-unicode11@0.9.0`.

- [ ] **Step 2: Verify the addons match the core version**

Run: `bun pm ls | grep xterm`
Expected: all six present, and **no peer-dependency warnings** in the `bun add` output above.

If an addon declares a peer on `@xterm/xterm@^5`, pin the whole set to 5.x instead (`bun add @xterm/xterm@^5.5.0 @xterm/addon-fit@^0.10.0 @xterm/addon-webgl@^0.18.0 @xterm/addon-clipboard@^0.1.0 @xterm/addon-web-links@^0.11.0 @xterm/addon-unicode11@^0.8.0`) and note the pin in the commit body. The component code below is unchanged either way — the APIs used are identical across both majors.

- [ ] **Step 3: Write the component**

Create `components/server-terminal.tsx`:

```tsx
"use client";

import "@xterm/xterm/css/xterm.css";

import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "@/components/ui/button";

// The browser half of the terminal. xterm reaches for `window` during
// construction, so the library is imported inside the effect rather than at
// module scope — that also keeps it out of the initial bundle for every other
// page.
//
// Transport: binary frames are tty bytes in both directions, text frames are
// JSON control messages (see lib/terminal/protocol).

type Status = "connecting" | "connected" | "reconnecting" | "closed";

// Matches Tailwind's neutral scale so the terminal doesn't look pasted in.
const THEMES = {
  dark: { background: "#0a0a0a", foreground: "#ededed", cursor: "#ededed" },
  light: { background: "#ffffff", foreground: "#171717", cursor: "#171717" },
} as const;

const WS_PATH = process.env.NEXT_PUBLIC_TERMINAL_WS_PATH ?? "/ws/terminal";
// 1s, 2s, 4s, 8s, then give up and let the user retry by hand — past the 60s
// grace window there is nothing left to reattach to anyway.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${WS_PATH}`;
}

export function ServerTerminal({
  serverId,
  cwd,
}: {
  serverId: string;
  cwd?: string;
}) {
  const t = useTranslations("terminal");
  const { resolvedTheme } = useTheme();
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = React.useState<Status>("connecting");
  const [error, setError] = React.useState<string | null>(null);
  // Bumping this re-runs the effect, which is what "Reconnect" does.
  const [attempt, setAttempt] = React.useState(0);
  // Survives reconnects within the effect's lifetime so a dropped socket
  // reattaches to the same remote shell instead of opening a second one.
  const sessionIdRef = React.useRef<string | null>(null);
  // The live terminal, so a theme change can restyle it without tearing down
  // the shell. Typed loosely to avoid importing xterm at module scope — the
  // library is loaded inside the effect precisely to keep it off other pages.
  const termRef = React.useRef<{ options: { theme: unknown } } | null>(null);

  const theme = resolvedTheme === "light" ? THEMES.light : THEMES.dark;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;
    const cleanups: (() => void)[] = [];

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { ClipboardAddon }, { Unicode11Addon }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-web-links"),
          import("@xterm/addon-clipboard"),
          import("@xterm/addon-unicode11"),
        ]);
      if (disposed) return;

      const term = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily:
          'var(--font-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace)',
        fontSize: 13,
        scrollback: 10_000,
        theme,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.loadAddon(new ClipboardAddon());
      const unicode = new Unicode11Addon();
      term.loadAddon(unicode);
      term.unicode.activeVersion = "11";
      term.open(host);
      // Registered BEFORE the next await: an unmount while the webgl import is
      // in flight would otherwise run a cleanup list that doesn't yet know
      // about a terminal that is already open (and already blinking a cursor).
      termRef.current = term;
      cleanups.push(() => {
        termRef.current = null;
        term.dispose();
      });

      // WebGL is an optimisation, not a requirement: a machine without a
      // working context (VM, remote desktop, blocklisted driver) must still
      // get a terminal, so a failure here is swallowed.
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // Canvas/DOM renderer it is.
      }
      // Second await boundary, second check: nothing below this line should
      // attach handlers or observers to a component that has gone away.
      if (disposed) return;

      fit.fit();

      const encoder = new TextEncoder();
      term.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(encoder.encode(data));
        }
      });
      term.onResize(({ cols, rows }) => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: "resize", cols, rows }));
        }
      });

      // One fit per frame: a drag-resize fires dozens of observer callbacks,
      // and each fit that changes geometry sends a window-change packet.
      let frame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          try {
            fit.fit();
          } catch {
            // The element can be mid-teardown.
          }
        });
      });
      observer.observe(host);
      cleanups.push(() => {
        cancelAnimationFrame(frame);
        observer.disconnect();
      });

      const connect = async (): Promise<void> => {
        if (disposed) return;
        setError(null);

        let ticket: string;
        try {
          const res = await fetch("/api/terminal/ticket", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ serverId, cwd }),
          });
          if (!res.ok) throw new Error(`ticket ${res.status}`);
          ticket = ((await res.json()) as { ticket: string }).ticket;
        } catch {
          if (disposed) return;
          setStatus("closed");
          setError(t("ticketFailed"));
          return;
        }
        if (disposed) return;

        const ws = new WebSocket(socketUrl());
        ws.binaryType = "arraybuffer";
        socket = ws;

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              t: "hello",
              ticket,
              cols: term.cols,
              rows: term.rows,
              ...(sessionIdRef.current
                ? { sessionId: sessionIdRef.current }
                : {}),
            })
          );
        };

        ws.onmessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") {
            term.write(new Uint8Array(event.data as ArrayBuffer));
            return;
          }
          const msg = JSON.parse(event.data) as
            | { t: "ready"; sessionId: string }
            | { t: "exit"; code: number | null; signal: string | null }
            | { t: "error"; message: string };
          if (msg.t === "ready") {
            sessionIdRef.current = msg.sessionId;
            retries = 0;
            setStatus("connected");
            term.focus();
            return;
          }
          if (msg.t === "exit") {
            // The remote shell ended on purpose; reattaching would be wrong.
            sessionIdRef.current = null;
            setStatus("closed");
            term.write(`\r\n\x1b[2m${t("sessionEnded")}\x1b[0m\r\n`);
            return;
          }
          setError(msg.message);
        };

        ws.onclose = () => {
          if (disposed) return;
          socket = null;
          // A clean exit already set "closed"; don't reconnect into a shell
          // that is gone.
          setStatus((current) => {
            if (current === "closed") return current;
            const delay = RETRY_DELAYS_MS[retries];
            if (delay === undefined) return "closed";
            retries++;
            retryTimer = setTimeout(() => void connect(), delay);
            return "reconnecting";
          });
        };
      };

      await connect();
    })();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      for (const cleanup of cleanups.splice(0)) cleanup();
    };
    // `theme` is deliberately NOT a dependency: it is applied by the effect
    // below, so switching light/dark restyles the terminal in place instead of
    // tearing down a live shell.
  }, [serverId, cwd, attempt, t]);

  // Restyle in place on a theme switch. xterm applies a new theme object to a
  // running terminal, so this costs a repaint rather than a reconnect.
  React.useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme;
  }, [theme]);

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={hostRef}
        className="h-[70vh] w-full overflow-hidden rounded-lg border bg-background p-2"
      />
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={
              status === "connected"
                ? "size-2 rounded-full bg-emerald-500"
                : status === "closed"
                  ? "size-2 rounded-full bg-muted-foreground"
                  : "size-2 animate-pulse rounded-full bg-amber-500"
            }
          />
          {t(`status.${status}`)}
          {error && <span className="text-destructive">· {error}</span>}
        </span>
        {(status === "closed" || error) && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setStatus("connecting");
              setAttempt((n) => n + 1);
            }}
          >
            {t("reconnect")}
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck and lint**

```bash
bun run check
bun run typecheck
```
Expected: clean. The component has no unit test — its behaviour is DOM + socket integration, covered by the sidecar tests on the protocol side and by the manual pass in Task 7.

- [ ] **Step 5: Commit**

```bash
git add components/server-terminal.tsx package.json bun.lock
git commit -m "feat(terminal): add xterm client with reattach and backoff"
```

---

### Task 6: Route, navigation and translations

**Files:**
- Create: `app/[locale]/servers/[id]/terminal/page.tsx`
- Create: `app/[locale]/servers/[id]/terminal/loading.tsx`
- Modify: `app/[locale]/servers/servers-client.tsx`
- Modify: `components/file-explorer.tsx`
- Modify: `app/[locale]/admin/activity/page.tsx`
- Modify: `messages/en.json`, `messages/id.json`, `messages/ar.json`, `messages/zh.json`

**Interfaces:**
- Consumes: `<ServerTerminal>` (Task 5).
- Produces: the route `/{locale}/servers/{id}/terminal?cwd=<path>`.

- [ ] **Step 1: Add the translations**

In `messages/en.json`, add a top-level `"terminal"` object (keep keys sorted the way the surrounding file is):

```json
  "terminal": {
    "title": "Terminal — {name}",
    "subtitle": "{username}@{host} over SSH",
    "openTerminal": "Open terminal",
    "reconnect": "Reconnect",
    "sessionEnded": "Session ended.",
    "ticketFailed": "Could not authorize the session.",
    "status": {
      "connecting": "Connecting…",
      "connected": "Connected",
      "reconnecting": "Reconnecting…",
      "closed": "Disconnected"
    }
  },
```

Add to the existing `"servers"` object in the same file:

```json
    "openTerminal": "Open terminal",
```

Add to the existing `"explorer"` object:

```json
    "openInTerminal": "Open in terminal",
```

Add to the existing `"activity"` object:

```json
    "terminalOpened": "{actor} opened a terminal on {server}",
    "terminalClosed": "{actor} closed a terminal on {server} after {seconds}s",
```

`messages/id.json` — same keys:

```json
  "terminal": {
    "title": "Terminal — {name}",
    "subtitle": "{username}@{host} melalui SSH",
    "openTerminal": "Buka terminal",
    "reconnect": "Sambungkan ulang",
    "sessionEnded": "Sesi berakhir.",
    "ticketFailed": "Tidak dapat mengotorisasi sesi.",
    "status": {
      "connecting": "Menyambungkan…",
      "connected": "Tersambung",
      "reconnecting": "Menyambungkan ulang…",
      "closed": "Terputus"
    }
  },
```
plus `"openTerminal": "Buka terminal"` in `servers`, `"openInTerminal": "Buka di terminal"` in `explorer`, and in `activity`:
```json
    "terminalOpened": "{actor} membuka terminal di {server}",
    "terminalClosed": "{actor} menutup terminal di {server} setelah {seconds} detik",
```

`messages/ar.json`:

```json
  "terminal": {
    "title": "الطرفية — {name}",
    "subtitle": "{username}@{host} عبر SSH",
    "openTerminal": "فتح الطرفية",
    "reconnect": "إعادة الاتصال",
    "sessionEnded": "انتهت الجلسة.",
    "ticketFailed": "تعذّر تفويض الجلسة.",
    "status": {
      "connecting": "جارٍ الاتصال…",
      "connected": "متصل",
      "reconnecting": "جارٍ إعادة الاتصال…",
      "closed": "غير متصل"
    }
  },
```
plus `"openTerminal": "فتح الطرفية"` in `servers`, `"openInTerminal": "فتح في الطرفية"` in `explorer`, and in `activity`:
```json
    "terminalOpened": "{actor} فتح طرفية على {server}",
    "terminalClosed": "{actor} أغلق طرفية على {server} بعد {seconds} ثانية",
```

`messages/zh.json`:

```json
  "terminal": {
    "title": "终端 — {name}",
    "subtitle": "通过 SSH 连接 {username}@{host}",
    "openTerminal": "打开终端",
    "reconnect": "重新连接",
    "sessionEnded": "会话已结束。",
    "ticketFailed": "无法授权会话。",
    "status": {
      "connecting": "连接中…",
      "connected": "已连接",
      "reconnecting": "重新连接中…",
      "closed": "已断开"
    }
  },
```
plus `"openTerminal": "打开终端"` in `servers`, `"openInTerminal": "在终端中打开"` in `explorer`, and in `activity`:
```json
    "terminalOpened": "{actor} 在 {server} 上打开了终端",
    "terminalClosed": "{actor} 在 {server} 上关闭了终端，持续 {seconds} 秒",
```

- [ ] **Step 2: Create the route**

Create `app/[locale]/servers/[id]/terminal/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getServerById } from "@/actions/servers";
import { PageHeader } from "@/components/page-header";
import { ServerTerminal } from "@/components/server-terminal";
import { requireAdmin } from "@/lib/auth-session";

export default async function ServerTerminalPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ cwd?: string | string[] }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  // The ticket route checks this too — this one keeps the page itself off
  // limits, so a non-admin never sees a terminal that would refuse to connect.
  await requireAdmin();

  const server = await getServerById(id);
  if (!server) notFound();

  const { cwd } = await searchParams;
  const t = await getTranslations("terminal");

  return (
    <>
      <PageHeader
        title={t("title", { name: server.name })}
        subtitle={t("subtitle", {
          username: server.username,
          host: server.host,
        })}
      />
      <ServerTerminal
        serverId={id}
        cwd={typeof cwd === "string" ? cwd : undefined}
      />
    </>
  );
}
```

Create `app/[locale]/servers/[id]/terminal/loading.tsx`:

```tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Skeleton className="h-[70vh] w-full rounded-lg" />
    </div>
  );
}
```

Check `app/[locale]/servers/[id]/loading.tsx` first and match whatever skeleton primitive it uses; if the project's skeleton import path differs, use that one.

- [ ] **Step 3: Wire the server list menu**

In `app/[locale]/servers/servers-client.tsx`:

Add `SquareTerminal` to the `lucide-react` import (alphabetical: after `Server as ServerIcon`).

Add `terminalLabel: string;` to the `ServerActions` prop type and destructuring, then insert this item as the first entry inside `<DropdownMenuContent align="end">`, above the edit item:

```tsx
          <DropdownMenuItem
            render={<Link href={`/servers/${server.id}/terminal`} />}
          >
            <SquareTerminal className="size-4" />
            {terminalLabel}
          </DropdownMenuItem>
```

At both `<ServerActions .../>` call sites (around lines 161 and 188, next to the existing `browseLabel={t("browseFiles")}`), add:

```tsx
            terminalLabel={t("openTerminal")}
```

- [ ] **Step 4: Wire the file explorer toolbar**

In `components/file-explorer.tsx`:

Add `SquareTerminal` to the `lucide-react` import, and add `import { Link } from "@/i18n/navigation";` if it is not already imported.

In the toolbar, immediately before the "New folder" `<Button>`, add:

```tsx
          {source.kind === "sftp" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              render={
                <Link
                  href={`/servers/${source.serverId}/terminal?cwd=${encodeURIComponent(path)}`}
                />
              }
            >
              <SquareTerminal className="size-4" />
              {t("openInTerminal")}
            </Button>
          )}
```

The guard is not cosmetic: an S3 source has no host to shell into, so the button must not exist there.

- [ ] **Step 5: Render the audit events**

In `app/[locale]/admin/activity/page.tsx`, add these cases to the `switch` in `message()`, after `case "milestone.created":`:

```tsx
    case "terminal.open":
      return t("terminalOpened", { actor, server: String(d.server) });
    case "terminal.close":
      return t("terminalClosed", {
        actor,
        server: String(d.server),
        seconds: String(d.seconds),
      });
```

`terminal.denied` deliberately gets no case: it falls through to `t("unknown")`, which is the right amount of noise for an event that is usually a stale bookmark.

- [ ] **Step 6: Verify the app builds and the routes resolve**

```bash
bun run check
bun run typecheck
bun run build
```
Expected: build succeeds and the output lists `/[locale]/servers/[id]/terminal`.

- [ ] **Step 7: Commit**

```bash
git add app/[locale]/servers/[id]/terminal app/[locale]/servers/servers-client.tsx components/file-explorer.tsx app/[locale]/admin/activity/page.tsx messages
git commit -m "feat(terminal): add terminal route and entry points from servers and explorer"
```

---

### Task 7: Deployment wiring and end-to-end verification

**Files:**
- Modify: `Dockerfile`
- Modify: `compose.yaml`
- Modify: `Caddyfile`
- Modify: `lib/env.ts`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: `lib/terminal/main.ts` (Task 4), the client's `NEXT_PUBLIC_TERMINAL_WS_PATH` default (Task 5).
- Produces: a `terminal` service reachable at `/ws/terminal` through Caddy.

- [ ] **Step 1: Bundle the sidecar in the image**

In `Dockerfile`, immediately after `RUN bun run build` in the `builder` stage:

```dockerfile
# The sidecar is a second entrypoint into the same codebase, so it ships in the
# same image and is selected by `command:` in compose. `--conditions
# react-server` makes the "server-only" package resolve to its empty stub, which
# is what lets this bundle reuse lib/db, lib/secrets and lib/activity verbatim
# instead of carrying a second copy of the data layer.
RUN bun build lib/terminal/main.ts --target=bun --conditions="react-server" \
    --outfile terminal-server.js
```

In the `runner` stage, after the `.next/static` copy:

```dockerfile
COPY --from=builder --chown=nextjs:nodejs /app/terminal-server.js ./terminal-server.js
```

- [ ] **Step 2: Add the compose service**

In `compose.yaml`, add `image: opsdeck-app:local` to the existing `app` service alongside its `build:` key, then add this service after `app`:

```yaml
  terminal:
    # Same image as `app` (declaring both build+image means compose builds it
    # once and reuses it), different entrypoint: this process owns the
    # WebSocket terminal sessions. Next 16 can't serve WebSockets from a route
    # handler, and keeping the sockets out of the app process means a redeploy
    # or a recompile can't kill a live root shell.
    build:
      context: .
    image: opsdeck-app:local
    container_name: opsdeck-terminal
    restart: always
    command: ["bun", "terminal-server.js"]
    # Internal only. Caddy is the single public surface.
    expose:
      - "3001"
    environment:
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}
      # Ticket signatures are derived from this — it MUST be the same value the
      # app uses, or every ticket is rejected.
      SECRETS_KEY: ${SECRETS_KEY:?SECRETS_KEY is required}
      # Origin allowed to open a socket (the app's public URL).
      BETTER_AUTH_URL: ${BETTER_AUTH_URL:-http://localhost:3000}
      TERMINAL_WS_PORT: ${TERMINAL_WS_PORT:-3001}
    healthcheck:
      test:
        [
          "CMD",
          "bun",
          "-e",
          "fetch('http://127.0.0.1:3001/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))",
        ]
      start_period: 20s
    depends_on:
      postgres:
        condition: service_healthy
```

- [ ] **Step 3: Route the socket path in Caddy**

Replace the `reverse_proxy app:3000 { … }` block in `Caddyfile` with:

```
	# WebSocket terminal sessions live in their own process (see compose.yaml).
	# Caddy proxies WebSockets natively — no special upgrade config needed.
	handle /ws/terminal* {
		reverse_proxy terminal:3001
	}

	handle {
		reverse_proxy app:3000 {
			# Next standalone doesn't trust X-Forwarded-* for nextUrl, so next-intl's
			# absolute locale redirects leak the internal listen port (:3000) into the
			# Location header. Strip it on the way back out.
			header_down Location ":3000/" "/"
		}
	}
```

- [ ] **Step 4: Validate the new env vars at boot**

In `lib/env.ts`, add this field schema next to the others:

```ts
const portSchema = z
  .string()
  .refine((v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n < 65_536;
  }, "must be a TCP port number (1-65535)");

// The path Caddy routes to the terminal sidecar. Must start with a slash and
// carry no scheme or host — the client derives ws:// or wss:// from the page.
const wsPathSchema = z
  .string()
  .regex(/^\/[\w\-/]*$/, "must be an absolute path, e.g. /ws/terminal");
```

And inside `collectFindings()`, after the `checkOptional("APP_TIMEZONE", …)` line:

```ts
  // Terminal sidecar. Both have working defaults (3001 and /ws/terminal), so a
  // deployment that never touches them is fine — a malformed override is not.
  checkOptional("TERMINAL_WS_PORT", portSchema, findings);
  checkOptional("NEXT_PUBLIC_TERMINAL_WS_PATH", wsPathSchema, findings);
```

- [ ] **Step 5: Document the vars**

Append to `.env.example`:

```bash
# --- Web terminal ------------------------------------------------------------
# The terminal runs in its own container (service `terminal` in compose.yaml)
# because Next cannot serve WebSockets from a route handler. It signs nothing of
# its own: session tickets are minted by the app and verified here using a key
# derived from SECRETS_KEY, so both services MUST share that value.
#
# Port the sidecar listens on inside the compose network. Optional.
TERMINAL_WS_PORT=3001
# Path Caddy routes to the sidecar, and the path the browser dials. Change both
# together or the terminal will not connect. Optional.
NEXT_PUBLIC_TERMINAL_WS_PATH=/ws/terminal
```

- [ ] **Step 6: Document the feature**

In `README.md`, add a bullet under `## Features`:

```markdown
- **Web terminal** — an interactive SSH shell in the browser, opened from the
  server list or from the file explorer at the folder being browsed. Admin-only;
  each session's open and close is written to the activity log (never its
  contents). Runs in its own container so a redeploy cannot kill a live shell.
```

And under `## Docker`, in whatever list enumerates the compose services, add:

```markdown
- `terminal` — WebSocket terminal sessions (same image as `app`, different entrypoint)
```

- [ ] **Step 7: Verify the compose file and the whole suite**

```bash
docker compose config >/dev/null && echo "compose ok"
bun test
bun run check
bun run typecheck
```
Expected: `compose ok`, all tests pass, no lint or type errors.

- [ ] **Step 8: Manual end-to-end pass**

```bash
docker compose up -d --build
```

Then, signed in as an admin, confirm each of these:

1. `/servers` → a row's `⋯` menu → **Open terminal** → a prompt appears.
2. Run `vim` (arrow keys, `:q!`), `htop` (redraws, `q`), and `less /var/log/syslog` (paging).
3. Drag the browser window narrower — the remote `tput cols` reflects the new width.
4. `/servers/<id>/files`, navigate into a folder, click **Open in terminal** → the shell starts in that folder (`pwd` confirms).
5. Kill wifi for ~15s, restore it → the status returns to Connected, scrollback intact, a running `top` still updating.
6. Kill wifi for ~90s → the status ends at Disconnected; **Reconnect** opens a fresh shell.
7. Sign in as a non-admin: the terminal menu entry is absent, and `curl -X POST /api/terminal/ticket` with that session returns 403.
8. `/admin/activity` shows the open and close events with the right server and duration.

- [ ] **Step 9: Commit**

```bash
git add Dockerfile compose.yaml Caddyfile lib/env.ts .env.example README.md
git commit -m "feat(terminal): ship the terminal sidecar service"
```

---

## Notes for the implementer

- **Do not** put the ticket in the WebSocket URL, even temporarily while debugging. Caddy logs URLs.
- **Do not** add a `cwd` fallback that silently lands in the root when confinement fails. The route returns 400 on purpose.
- The `cwd` is interpolated into a single-quoted shell line. `resolveTerminalCwd` rejects quotes and newlines; if you change one of those two places, change both.
- The sidecar shares `SECRETS_KEY` with the app. A deployment where they differ fails with "Ticket bad-signature" on every connection — that is the first thing to check if nothing connects.
- Sessions are in-memory. Restarting the `terminal` container drops every live shell, by design.
