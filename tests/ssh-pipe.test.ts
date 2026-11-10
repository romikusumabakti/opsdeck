import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server, utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// pipeToRemoteCommand against a real in-process SSH server (ssh2's Server):
// the body reaches the command's stdin in order and complete, a failing
// command rejects promptly with its stderr and cancels the body, and a
// timeout rejects instead of hanging.

const PASSWORD = "pipe-test-password";
const port = vi.hoisted(() => ({ value: 0 }));
const received = vi.hoisted(() => ({ sha: "", bytes: 0 }));

vi.mock("@/lib/ssh-connect", () => ({
  connectConfig: async () => ({
    host: "127.0.0.1",
    port: port.value,
    username: "ops",
    password: PASSWORD,
    hostVerifier: () => true,
  }),
  connectError: (_c: unknown, error: unknown) => error,
  connectSucceeded: () => {},
  HostKeyMismatchError: class extends Error {},
}));

const { pipeToRemoteCommand } = await import("@/lib/ssh");
const target = {} as Parameters<typeof pipeToRemoteCommand>[0];

let server: Server;

beforeAll(async () => {
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.password === PASSWORD) ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        switch (info.command) {
          case "sink": {
            const hash = createHash("sha256");
            let bytes = 0;
            stream.on("data", (d: Buffer) => {
              hash.update(d);
              bytes += d.length;
            });
            stream.on("end", () => {
              received.sha = hash.digest("hex");
              received.bytes = bytes;
              stream.write("ok\n");
              stream.exit(0);
              stream.end();
            });
            break;
          }
          case "fail-early":
            stream.stderr.write("tar: invalid magic\n");
            stream.exit(2);
            stream.end();
            break;
          case "hang":
            break;
        }
      });
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  port.value = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

function bodyOf(
  chunks: number,
  chunkSize: number,
  state: { pulled: number; cancelled: boolean }
) {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(chunkSize).fill(state.pulled % 251);
      state.pulled += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
}

describe("pipeToRemoteCommand", () => {
  it("delivers a 1 MiB body in order and complete", async () => {
    const state = { pulled: 0, cancelled: false };
    const expected = createHash("sha256");
    for (let i = 0; i < 16; i += 1) {
      expected.update(new Uint8Array(64 * 1024).fill(i % 251));
    }
    const result = await pipeToRemoteCommand(
      target,
      "sink",
      bodyOf(16, 64 * 1024, state),
      { timeoutMs: 10_000 }
    );
    expect(result.stdout).toBe("ok\n");
    expect(received.bytes).toBe(1024 * 1024);
    expect(received.sha).toBe(expected.digest("hex"));
  });

  it("rejects with stderr on a non-zero exit and cancels the body", async () => {
    const state = { pulled: 0, cancelled: false };
    // Large and endless enough that it cannot all be buffered.
    const body = bodyOf(100_000, 64 * 1024, state);
    await expect(
      pipeToRemoteCommand(target, "fail-early", body, { timeoutMs: 10_000 })
    ).rejects.toThrow(/exit 2.*tar: invalid magic/s);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(1000);
  });

  it("redacts secrets from the thrown message", async () => {
    const state = { pulled: 0, cancelled: false };
    await expect(
      pipeToRemoteCommand(target, "fail-early", bodyOf(1, 10, state), {
        timeoutMs: 10_000,
        secrets: ["invalid magic"],
      })
    ).rejects.toThrow(/tar: \[redacted\]/);
  });

  it("rejects on timeout and cancels the body", async () => {
    const state = { pulled: 0, cancelled: false };
    const started = Date.now();
    await expect(
      pipeToRemoteCommand(target, "hang", bodyOf(100_000, 64 * 1024, state), {
        timeoutMs: 300,
      })
    ).rejects.toThrow(/timed out after 300ms/);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(state.cancelled).toBe(true);
  });
});
