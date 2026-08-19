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
      options.clearTimer ??
      ((t) => clearTimeout(t as Parameters<typeof clearTimeout>[0]));
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
    // A racing reconnect (a second tab resuming the same session) must not
    // leave the displaced socket attached and unaware it was replaced.
    if (session.sink) {
      try {
        session.sink.close();
      } catch {
        // Already gone.
      }
    }
    session.sink = sink;

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
  // what stops output arriving, so nothing would ever call back in. The
  // socket layer calls this from its drain event, which is the only moment
  // the buffer is known to have shrunk.
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
