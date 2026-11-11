import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  clients: [] as unknown[],
  connectError: vi.fn(),
  connectSucceeded: vi.fn(),
}));

vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeChannel extends EventEmitter {
    stderr = new EventEmitter();
    write = vi.fn();
    end = vi.fn();
    close = vi.fn();
  }
  class FakeSftp {
    fastGet = vi.fn(
      (_r: string, _l: string, cb: (err?: Error | null) => void) => cb()
    );
    fastPut = vi.fn(
      (_l: string, _r: string, cb: (err?: Error | null) => void) => cb()
    );
    end = vi.fn();
  }
  class FakeClient extends EventEmitter {
    config: unknown;
    channel = new FakeChannel();
    sftpHandle = new FakeSftp();
    execError: Error | null = null;
    connect = vi.fn((config: unknown) => {
      this.config = config;
    });
    exec = vi.fn(
      (_cmd: string, cb: (err: Error | null, c?: unknown) => void) =>
        this.execError ? cb(this.execError) : cb(null, this.channel)
    );
    sftp = vi.fn((cb: (err: Error | null, s?: unknown) => void) =>
      cb(null, this.sftpHandle)
    );
    end = vi.fn(() => {
      this.emit("close");
    });
    constructor() {
      super();
      h.clients.push(this);
    }
  }
  return { Client: FakeClient };
});

vi.mock("@/lib/ssh-connect", () => ({
  connectConfig: vi.fn(async () => ({ host: "h", username: "u" })),
  connectError: h.connectError,
  connectSucceeded: h.connectSucceeded,
}));

import { openSsh, type SshSession } from "@/lib/ssh-session";

const target = {
  serverId: null,
  host: "h",
  username: "u",
  password: null,
  auth: "password",
} as const;

// biome-ignore lint/suspicious/noExplicitAny: the fake client's test handles
type Fake = any;
const lastClient = (): Fake => h.clients.at(-1);

// Starts openSsh and waits until the client is asked to connect.
async function start(tuning = {}) {
  const pending = openSsh(target, tuning);
  await vi.waitFor(() => expect(lastClient()?.connect).toHaveBeenCalled());
  return { pending, client: lastClient() as Fake };
}

async function connected(): Promise<{ session: SshSession; client: Fake }> {
  const { pending, client } = await start();
  client.emit("ready");
  return { session: await pending, client };
}

beforeEach(() => {
  h.clients.length = 0;
  h.connectError.mockReset();
  h.connectError.mockImplementation((_c: unknown, e: unknown) => e);
  h.connectSucceeded.mockReset();
});

describe("openSsh", () => {
  it("resolves on ready and calls connectSucceeded", async () => {
    const { pending, client } = await start({ readyTimeout: 5000 });
    expect(client.config).toEqual({
      host: "h",
      username: "u",
      readyTimeout: 5000,
    });
    client.emit("ready");
    const session = await pending;
    expect(session.client).toBe(client);
    expect(session.isConnected()).toBe(true);
    expect(h.connectSucceeded).toHaveBeenCalledWith({
      host: "h",
      username: "u",
    });
  });

  it("rejects with connectError(config, err) on an error before ready", async () => {
    const mapped = new Error("mapped");
    h.connectError.mockReturnValue(mapped);
    const { pending, client } = await start();
    const raw = new Error("boom");
    client.emit("error", raw);
    await expect(pending).rejects.toBe(mapped);
    expect(h.connectError).toHaveBeenCalledWith(
      { host: "h", username: "u" },
      raw
    );
    expect(client.end).toHaveBeenCalled();
    expect(h.connectSucceeded).not.toHaveBeenCalled();
  });

  it("rejects when the server closes before ready", async () => {
    const { pending, client } = await start();
    client.emit("close");
    await expect(pending).rejects.toThrow("No response from server");
  });

  it("an error after ready does not throw", async () => {
    const { session, client } = await connected();
    expect(() => client.emit("error", new Error("ECONNRESET"))).not.toThrow();
    client.emit("close");
    expect(session.isConnected()).toBe(false);
  });
});

describe("execCommand", () => {
  it("writes stdin, ends the channel and trims output", async () => {
    const { session, client } = await connected();
    const result = session.execCommand("cat", { stdin: "in" });
    const ch = client.channel;
    ch.emit("data", Buffer.from(" a\n"));
    ch.stderr.emit("data", Buffer.from("e\n"));
    ch.emit("exit", 0, undefined);
    ch.emit("close");
    await expect(result).resolves.toEqual({
      code: 0,
      signal: null,
      stdout: "a",
      stderr: "e",
    });
    expect(ch.write).toHaveBeenCalledWith("in");
    expect(ch.end).toHaveBeenCalledTimes(1);
  });

  it("with noTrim keeps the trailing newline", async () => {
    const { session, client } = await connected();
    const result = session.execCommand("ls", { noTrim: true });
    client.channel.emit("data", Buffer.from("k1\nk2\n"));
    client.channel.emit("exit", 0);
    client.channel.emit("close");
    expect((await result).stdout).toBe("k1\nk2\n");
    expect(client.channel.write).not.toHaveBeenCalled();
    expect(client.channel.end).toHaveBeenCalledTimes(1);
  });

  it("reports a signal", async () => {
    const { session, client } = await connected();
    const result = session.execCommand("sleep 9");
    client.channel.emit("exit", null, "TERM");
    client.channel.emit("close");
    expect(await result).toMatchObject({ code: null, signal: "TERM" });
  });

  it("forwards onChannel/onStdout/onStderr", async () => {
    const { session, client } = await connected();
    const onChannel = vi.fn();
    const onStdout = vi.fn();
    const onStderr = vi.fn();
    const result = session.execCommand("x", { onChannel, onStdout, onStderr });
    const out = Buffer.from("o");
    const err = Buffer.from("e");
    client.channel.emit("data", out);
    client.channel.stderr.emit("data", err);
    client.channel.emit("close");
    await result;
    expect(onChannel).toHaveBeenCalledWith(client.channel);
    expect(onStdout).toHaveBeenCalledWith(out);
    expect(onStderr).toHaveBeenCalledWith(err);
  });

  it("rejects when exec errors", async () => {
    const { session, client } = await connected();
    client.execError = new Error("exec failed");
    await expect(session.execCommand("x")).rejects.toThrow("exec failed");
  });
});

describe("file transfer", () => {
  it("getFile/putFile use fastGet/fastPut and end the channel", async () => {
    const { session, client } = await connected();
    await session.getFile("/local", "/remote");
    expect(client.sftpHandle.fastGet).toHaveBeenCalledWith(
      "/remote",
      "/local",
      expect.any(Function)
    );
    await session.putFile("/local", "/remote");
    expect(client.sftpHandle.fastPut).toHaveBeenCalledWith(
      "/local",
      "/remote",
      expect.any(Function)
    );
    expect(client.sftpHandle.end).toHaveBeenCalledTimes(2);
  });

  it("reject on the transfer error", async () => {
    const { session, client } = await connected();
    client.sftpHandle.fastGet.mockImplementation(
      (_r: string, _l: string, cb: (e: Error) => void) =>
        cb(new Error("no get"))
    );
    client.sftpHandle.fastPut.mockImplementation(
      (_l: string, _r: string, cb: (e: Error) => void) =>
        cb(new Error("no put"))
    );
    await expect(session.getFile("/l", "/r")).rejects.toThrow("no get");
    await expect(session.putFile("/l", "/r")).rejects.toThrow("no put");
    expect(client.sftpHandle.end).toHaveBeenCalledTimes(2);
  });
});

describe("dispose", () => {
  it("is idempotent", async () => {
    const { session, client } = await connected();
    session.dispose();
    expect(() => session.dispose()).not.toThrow();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("isConnected is false right after dispose", async () => {
    const { session, client } = await connected();
    // Hold back the close event the fake emits from end().
    client.end.mockImplementationOnce(() => {});
    expect(session.isConnected()).toBe(true);
    session.dispose();
    expect(session.isConnected()).toBe(false);
  });

  it("dispose after the remote end closed does not throw", async () => {
    const { session, client } = await connected();
    client.emit("close");
    expect(session.isConnected()).toBe(false);
    expect(() => session.dispose()).not.toThrow();
    expect(session.isConnected()).toBe(false);
  });
});
