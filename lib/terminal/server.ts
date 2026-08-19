import type { ServerWebSocket } from "bun";
import {
  createNonceGuard,
  parseClientMessage,
  type ServerMessage,
  verifyTicket,
} from "@/lib/terminal/protocol";
import {
  type DestroyReason,
  type Session,
  SessionRegistry,
  type Sink,
  TooManySessionsError,
} from "@/lib/terminal/session";
import type {
  ShellOptions,
  ShellSession,
  ShellTarget,
} from "@/lib/terminal/ssh-shell";

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
  // `serverName` is set only on the paths where the server row was actually
  // loaded before the denial (ssh-failed, too-many-sessions) — everywhere
  // else the target is never fetched, so there is no name to give.
  | {
      kind: "denied";
      userId: string | null;
      serverId: string | null;
      serverName: string | null;
      reason: string;
    };

export type TerminalDeps = {
  loadServer(serverId: string): Promise<TerminalTarget | null>;
  openShell(
    target: TerminalTarget,
    options: ShellOptions
  ): Promise<ShellSession>;
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
        serverName: null,
        reason: `ticket-${verified.reason}`,
      });
      fail(ws, `Ticket ${verified.reason}`);
      return;
    }
    const { uid, sid, cwd, jti, exp } = verified.payload;

    // A ticket is good once. Without this, a ticket captured in flight could
    // open a second shell inside its 30s window.
    if (!nonces.accept(jti, exp)) {
      deps.audit({
        kind: "denied",
        userId: uid,
        serverId: sid,
        serverName: null,
        reason: "replay",
      });
      fail(ws, "Ticket already used");
      return;
    }

    const target = await deps.loadServer(sid);
    if (!target) {
      deps.audit({
        kind: "denied",
        userId: uid,
        serverId: sid,
        serverName: null,
        reason: "unknown-server",
      });
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
    // window. Ownership is checked against both ids up front — via the same
    // check registry.attach() makes internally — so "ready" can go out
    // BEFORE calling attach(), which itself sends the replayed backlog.
    // Nothing async runs between the two, so the check still holds by the
    // time attach() runs. This ordering matters because onHello runs after
    // an `await`, outside of Bun's message-handler auto-cork: two sends made
    // here go out as two independent writes, and only send ORDER (which a
    // single WebSocket connection is guaranteed to preserve end-to-end) — not
    // send TIMING — decides what the client sees first.
    if (msg.sessionId) {
      const sessionId = msg.sessionId;
      const existing = registry.get(sessionId);
      const canResume =
        existing && existing.userId === uid && existing.serverId === sid;
      if (canResume) {
        send(ws, { t: "ready", sessionId });
        const resumed = registry.attach(sessionId, uid, sid, sink);
        if (resumed) {
          // Same hole as on the fresh path: a client that left during the
          // `loadServer` await never detached, because it had no session when
          // it closed. Attaching would bind a live shell to a dead socket AND
          // clear its grace timer, leaving nothing but the 30-minute idle
          // reaper. Detach (not destroy) — a genuine reconnect should still
          // find the shell waiting inside a fresh grace window.
          if (ws.readyState !== WebSocket.OPEN) {
            registry.detach(resumed);
            return;
          }
          ws.data.session = resumed;
          resumed.shell.resize(msg.cols, msg.rows);
          return;
        }
        // `attach` only returns null for a session that is gone or not ours,
        // and the reattach branch is entered only when it is neither — so
        // this is unreachable. Assert it rather than falling through: the
        // fresh-open path below would send a SECOND `ready` with a different
        // session id.
        fail(ws, "Session could not be resumed");
        return;
      }
      // Fall through: the session is gone, so open a fresh one rather than
      // erroring — from the user's side this is just "the shell restarted".
    }

    let shell: ShellSession;
    try {
      shell = await deps.openShell(target, {
        cols: msg.cols,
        rows: msg.rows,
        ...(cwd ? { cwd } : {}),
      });
    } catch (error) {
      deps.audit({
        kind: "denied",
        userId: uid,
        serverId: sid,
        serverName: target.name,
        reason: "ssh-failed",
      });
      fail(
        ws,
        error instanceof Error ? error.message : "SSH connection failed"
      );
      return;
    }

    let session: Session;
    try {
      session = registry.create({ userId: uid, serverId: sid, shell, sink });
    } catch (error) {
      shell.close();
      if (error instanceof TooManySessionsError) {
        deps.audit({
          kind: "denied",
          userId: uid,
          serverId: sid,
          serverName: target.name,
          reason: "too-many-sessions",
        });
        fail(ws, "Too many open terminals");
        return;
      }
      throw error;
    }

    shell.onData((chunk) => registry.onOutput(session, chunk));
    shell.onExit((info) => {
      // Through `session.sink`, not the captured `ws`: after a reattach the
      // session's connection is a different socket, and writing the exit
      // frame to the old one drops it silently — the user sees a disconnect
      // instead of a clean exit, and loses the exit code.
      const sink = session.sink;
      if (sink) sendTo(sink, { t: "exit", ...info });
      registry.destroy(session, "exit");
    });

    ws.data.session = session;
    audited.set(session.id, { userId: uid, target });
    deps.audit({ kind: "open", userId: uid, target });

    // The SSH handshake can take seconds; a client that gave up in the
    // meantime never triggers the close handler's detach path, because it had
    // no session to detach when it closed. Without this the shell would sit
    // attached to a dead socket — no grace timer, just the 30-minute idle
    // reaper — holding one of the user's four slots and a live root shell.
    // Checked after the audit above so an open that never really had a
    // client still produces a matching open/close pair instead of vanishing
    // from the log.
    if (ws.readyState !== WebSocket.OPEN) {
      registry.destroy(session, "exit");
      return;
    }

    send(ws, { t: "ready", sessionId: session.id });
  }

  return {
    registry,

    fetch(
      req: Request,
      server: { upgrade(req: Request, opts: { data: SocketData }): boolean }
    ) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return new Response("ok");

      // A cross-origin page must not be able to open a socket with a stolen
      // cookie-free ticket, and the browser sends Origin on every upgrade.
      if (deps.allowedOrigin) {
        const origin = req.headers.get("origin");
        if (origin !== deps.allowedOrigin) {
          // A misconfigured BETTER_AUTH_URL (the usual first-run mistake) makes
          // this fire on every single connection, and the WebSocket API hides
          // the 403 from the browser entirely — this line is the only place
          // the mismatch is ever visible.
          console.error(
            `terminal: rejected WebSocket upgrade — origin "${origin}" !== expected "${deps.allowedOrigin}"`
          );
          return new Response("Forbidden", { status: 403 });
        }
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
