import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { mintTicket } from "@/lib/terminal/protocol";
import { createTerminalHandlers } from "@/lib/terminal/server";
import { DEFAULT_LIMITS, SessionRegistry } from "@/lib/terminal/session";
import { openSshShell } from "@/lib/terminal/ssh-shell";

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

function handlers(
  options: {
    // Collected in place rather than returned, so callers who only need the
    // default (discard) behaviour can keep calling handlers() with no args.
    audited?: Record<string, unknown>[];
    registry?: SessionRegistry;
  } = {}
) {
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
    audit: (event) => {
      options.audited?.push(event as unknown as Record<string, unknown>);
    },
    ...(options.registry ? { registry: options.registry } : {}),
  });
}

// Drive a real WebSocket client against a real Bun.serve instance: the message
// loop, the frame-type discrimination, and the ssh2 channel are exactly what
// ships.
async function withServer<T>(run: (url: string) => Promise<T>): Promise<T> {
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
      first.ws.send(JSON.stringify({ t: "hello", ticket, cols: 80, rows: 24 }));
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

  it("reattaching over a still-open socket does not arm a stray grace timer", async () => {
    // A short graceMs makes the close-then-assign bug manifest inside the
    // test's timeout instead of requiring a real 60s wait: if the displaced-
    // socket guard in the close handler ever detaches a session that is
    // actually still attached (via its NEW sink), the resulting grace timer
    // fires fast enough here to destroy the session before the assertions
    // run. Against the old ordering this test fails; against the fix it
    // doesn't, because no grace timer is ever armed for a live reattach.
    const registry = new SessionRegistry({
      limits: { ...DEFAULT_LIMITS, graceMs: 50 },
    });
    const { fetch, websocket } = handlers({ registry });
    const server = Bun.serve({ port: 0, fetch, websocket });
    try {
      const url = `ws://127.0.0.1:${server.port}/ws/terminal`;
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

      // Reattach WITHOUT closing the first socket — the primary path per the
      // review: Bun's idleTimeout is 120s, so a dropped client's old socket
      // is almost always still open when the reconnect arrives.
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
      await second.until(() => second.control.some((m) => m.t === "ready"));

      // Long enough for the (buggy) 50ms grace timer to have fired, if one
      // was wrongly armed by the reattach above.
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(registry.get(ready.sessionId)).toBeDefined();
      second.ws.send(new TextEncoder().encode("still-here"));
      await second.until(() => second.output().includes("echo:still-here"));

      first.ws.close();
      second.ws.close();
    } finally {
      registry.destroyAll();
      server.stop(true);
    }
  });

  it("refuses a reattach with a different uid", async () => {
    await withServer(async (url) => {
      const owner = connect(url);
      await owner.open;
      owner.ws.send(
        JSON.stringify({
          t: "hello",
          ticket: mintTicket({ uid: "u1", sid: "server-1", cwd: "" }),
          cols: 80,
          rows: 24,
        })
      );
      await owner.until(() => owner.control.some((m) => m.t === "ready"));
      const ready = owner.control.find((m) => m.t === "ready") as {
        sessionId: string;
      };
      owner.ws.close();

      const intruder = connect(url);
      await intruder.open;
      intruder.ws.send(
        JSON.stringify({
          t: "hello",
          ticket: mintTicket({ uid: "u2", sid: "server-1", cwd: "" }),
          cols: 80,
          rows: 24,
          sessionId: ready.sessionId,
        })
      );
      await intruder.until(() => intruder.control.some((m) => m.t === "ready"));
      const resumed = intruder.control.find((m) => m.t === "ready") as {
        sessionId: string;
      };
      // A fresh session, not the owner's — ownership mismatch is refused
      // silently (as "gone"), same as a session that no longer exists.
      expect(resumed.sessionId).not.toBe(ready.sessionId);
      intruder.ws.close();
    });
  });

  it("audits open and denied events with the documented action kinds", async () => {
    const audited: Record<string, unknown>[] = [];
    const { fetch, websocket, registry } = handlers({ audited });
    const server = Bun.serve({ port: 0, fetch, websocket });
    try {
      const url = `ws://127.0.0.1:${server.port}/ws/terminal`;
      const ticket = mintTicket({ uid: "u1", sid: "server-1", cwd: "" });

      const client = connect(url);
      await client.open;
      client.ws.send(
        JSON.stringify({ t: "hello", ticket, cols: 80, rows: 24 })
      );
      await client.until(() => client.control.some((m) => m.t === "ready"));
      expect(audited.some((e) => e.kind === "open")).toBe(true);

      const replay = connect(url);
      await replay.open;
      replay.ws.send(
        JSON.stringify({ t: "hello", ticket, cols: 80, rows: 24 })
      );
      await replay.until(() => replay.control.some((m) => m.t === "error"));
      expect(audited.some((e) => e.kind === "denied")).toBe(true);

      client.ws.close();
      replay.ws.close();
    } finally {
      registry.destroyAll();
      server.stop(true);
    }
  });

  it("detaches instead of stranding a reattach whose client left during loadServer", async () => {
    // Gate the SECOND loadServer call only (the first hello, which creates
    // the session, must resolve immediately) so the test can close the
    // reattaching socket while onHello is still parked on the `await`,
    // mirroring a client that gives up mid-reconnect.
    const registry = new SessionRegistry();
    let calls = 0;
    let releaseSecondLoad: (() => void) | undefined;
    const { fetch, websocket } = createTerminalHandlers({
      allowedOrigin: null,
      registry,
      loadServer: async (id) => {
        calls++;
        if (calls === 2) {
          await new Promise<void>((resolve) => {
            releaseSecondLoad = resolve;
          });
        }
        return id === "server-1"
          ? {
              id: "server-1",
              name: "Test",
              host: "127.0.0.1",
              port: sshdPort,
              username: "tester",
              password: "correct-horse",
            }
          : null;
      },
      openShell: (target, opts) => openSshShell(target, opts),
      audit: () => {},
    });
    const server = Bun.serve({ port: 0, fetch, websocket });
    try {
      const url = `ws://127.0.0.1:${server.port}/ws/terminal`;
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

      // Wait for the reattach's loadServer call to be parked on the gate,
      // then close the client before it resolves.
      await Bun.sleep(50);
      expect(releaseSecondLoad).toBeDefined();
      second.ws.close();
      await Bun.sleep(50);
      releaseSecondLoad?.();

      // Give onHello's continuation a moment to run attach() and the
      // readyState guard after it.
      await Bun.sleep(100);

      const session = registry.get(ready.sessionId);
      expect(session).toBeDefined();
      // Detached, not left attached to the dead socket: sink is null, and
      // (unlike a fresh-open abandonment) the session survives rather than
      // being destroyed, so a genuine reconnect still finds it.
      expect(session?.sink).toBeNull();

      first.ws.close();
    } finally {
      registry.destroyAll();
      server.stop(true);
    }
  });
});
