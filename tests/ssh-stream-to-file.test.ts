import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// streamRemoteCommandToFile against a real in-process SSH server (ssh2's
// Server): stdout lands in the file chunk by chunk, stdin reaches the
// command, the exit code and stderr come back, and a dropped connection or
// a timeout throws instead of hanging or crashing.

const PASSWORD = "stream-test-password";
const ROOT = mkdtempSync(join(tmpdir(), "ssh-stream-"));
const CHUNK = Buffer.alloc(64 * 1024, 7);
const CHUNKS = 64; // 4 MiB

const port = vi.hoisted(() => ({ value: 0 }));

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

const { streamRemoteCommandToFile } = await import("@/lib/ssh");

let server: Server;

beforeAll(async () => {
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.password === PASSWORD) {
        ctx.accept();
      } else {
        ctx.reject(["password"]);
      }
    });
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        switch (info.command) {
          case "big":
            // Written at once: ssh2 queues it and the client's window and
            // the file stream's backpressure pace the transfer.
            stream.stderr.write("done\n");
            for (let i = 0; i < CHUNKS; i += 1) stream.write(CHUNK);
            stream.exit(0);
            stream.end();
            break;
          case "echo-stdin": {
            const parts: Buffer[] = [];
            stream.on("data", (d: Buffer) => parts.push(d));
            stream.on("end", () => {
              stream.write(Buffer.concat(parts));
              stream.exit(0);
              stream.end();
            });
            break;
          }
          case "fail":
            stream.write("partial");
            stream.stderr.write("pg_dump: error: boom\n");
            stream.exit(3);
            stream.end();
            break;
          case "drop":
            stream.write("partial");
            setTimeout(() => client.end(), 20);
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
  rmSync(ROOT, { recursive: true, force: true });
});

const target = {
  serverId: "",
  host: "127.0.0.1",
  username: "ops",
  password: PASSWORD,
  auth: "password" as const,
};

describe("streamRemoteCommandToFile", () => {
  it("writes the whole stdout into the file, 0600, with the exit code", async () => {
    const file = join(ROOT, "big");
    const result = await streamRemoteCommandToFile(target, "big", file, {
      timeoutMs: 30_000,
    });
    expect(result).toEqual({
      code: 0,
      bytes: CHUNK.length * CHUNKS,
      stderr: "done\n",
    });
    expect(statSync(file).size).toBe(CHUNK.length * CHUNKS);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("feeds stdin to the command and closes it", async () => {
    const file = join(ROOT, "stdin");
    const result = await streamRemoteCommandToFile(target, "echo-stdin", file, {
      timeoutMs: 10_000,
      stdin: "secret\n",
    });
    expect(result.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("secret\n");
  });

  it("returns a non-zero exit and stderr without throwing", async () => {
    const result = await streamRemoteCommandToFile(
      target,
      "fail",
      join(ROOT, "fail"),
      { timeoutMs: 10_000 }
    );
    expect(result).toEqual({
      code: 3,
      bytes: 7,
      stderr: "pg_dump: error: boom\n",
    });
  });

  it("reports no exit code when the connection drops mid-stream", async () => {
    const result = await streamRemoteCommandToFile(
      target,
      "drop",
      join(ROOT, "drop"),
      { timeoutMs: 10_000 }
    ).catch((error: unknown) => error);
    // Either way the caller sees a failure, never a success.
    if (result instanceof Error) return;
    expect((result as { code: number | null }).code).toBe(null);
  });

  it("times out a command that never ends", async () => {
    await expect(
      streamRemoteCommandToFile(target, "hang", join(ROOT, "hang"), {
        timeoutMs: 300,
      })
    ).rejects.toThrow(/timed out/);
  });
});
