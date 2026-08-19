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
