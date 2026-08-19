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
