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
    setFlowing(f) {
      this.flowing = f;
    },
  };
}

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
    clearTimeout(id: unknown) {
      timers.delete(id as number);
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
    expect(
      registry.attach("no-such-session", "u1", "s1", fakeSink())
    ).toBeNull();
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
    const shell = fakeShell();
    const session = registry.create({
      userId: "u1",
      serverId: "s1",
      shell,
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
