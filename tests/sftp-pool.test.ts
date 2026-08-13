import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  vi,
} from "bun:test";
import { EventEmitter } from "node:events";

// The pool dials node-ssh directly, so the fake lives at the module boundary.
// Each FakeSSH instance records one dial; the tests assert on how many were made.
const dials: FakeSSH[] = [];

class FakeSSH {
  connection = new EventEmitter();
  connected = true;
  disposed = false;
  sftp = { id: dials.length };
  connectOptions: Record<string, unknown> | undefined;

  constructor() {
    dials.push(this);
  }

  async connect(options: Record<string, unknown>) {
    this.connectOptions = options;
    if (options.password === "wrong") {
      this.connected = false;
      throw new Error("All configured authentication methods failed");
    }
  }

  async requestSFTP() {
    return this.sftp;
  }

  isConnected() {
    return this.connected;
  }

  dispose() {
    this.disposed = true;
    this.connected = false;
  }

  // Simulate the remote end going away (server restart, network drop).
  kill() {
    this.connected = false;
    this.connection.emit("close");
  }
}

mock.module("node-ssh", () => ({ NodeSSH: FakeSSH }));

const creds = { host: "10.0.0.1", username: "root", password: "s3cret" };

let leaseSftp: typeof import("@/lib/explorer/sftp-pool").leaseSftp;
let withPooledSftp: typeof import("@/lib/explorer/sftp-pool").withPooledSftp;
let reset: typeof import("@/lib/explorer/sftp-pool").__resetSftpPool;

beforeEach(async () => {
  const mod = await import("@/lib/explorer/sftp-pool");
  leaseSftp = mod.leaseSftp;
  withPooledSftp = mod.withPooledSftp;
  reset = mod.__resetSftpPool;
  dials.length = 0;
});

afterEach(() => {
  reset();
  vi.useRealTimers();
});

describe("sftp connection pool", () => {
  it("dials once for repeated operations on the same server", async () => {
    await withPooledSftp(creds, async () => "a");
    await withPooledSftp(creds, async () => "b");
    await withPooledSftp(creds, async () => "c");

    expect(dials).toHaveLength(1);
  });

  it("dials once when concurrent callers race the first operation", async () => {
    await Promise.all([
      withPooledSftp(creds, async () => "a"),
      withPooledSftp(creds, async () => "b"),
    ]);

    expect(dials).toHaveLength(1);
  });

  it("hands the same channel to every caller", async () => {
    const first = await withPooledSftp(creds, async (sftp) => sftp);
    const second = await withPooledSftp(creds, async (sftp) => sftp);

    expect(second).toBe(first);
  });

  it("keeps separate connections per host and per user", async () => {
    await withPooledSftp(creds, async () => null);
    await withPooledSftp({ ...creds, host: "10.0.0.2" }, async () => null);
    await withPooledSftp({ ...creds, username: "deploy" }, async () => null);

    expect(dials).toHaveLength(3);
  });

  it("does not reuse a connection after the password changes", async () => {
    await withPooledSftp(creds, async () => null);
    await withPooledSftp({ ...creds, password: "rotated" }, async () => null);

    expect(dials).toHaveLength(2);
  });

  it("releases the lease even when the operation throws", async () => {
    vi.useFakeTimers();
    await expect(
      withPooledSftp(creds, async () => {
        throw new Error("readdir failed");
      })
    ).rejects.toThrow("readdir failed");

    // A leaked lease would pin the connection open forever.
    vi.advanceTimersByTime(60_000);
    expect(dials[0].disposed).toBe(true);
  });

  it("re-dials after the pooled connection dies", async () => {
    await withPooledSftp(creds, async () => null);
    dials[0].kill();

    await withPooledSftp(creds, async () => null);

    expect(dials).toHaveLength(2);
    expect(dials[1].disposed).toBe(false);
  });

  it("re-dials when the connection died without emitting close", async () => {
    await withPooledSftp(creds, async () => null);
    // Half-open socket: still cached, but isConnected() is already false.
    dials[0].connected = false;

    await withPooledSftp(creds, async () => null);

    expect(dials).toHaveLength(2);
  });

  it("closes an idle connection after the TTL and dials again on next use", async () => {
    vi.useFakeTimers();
    await withPooledSftp(creds, async () => null);
    expect(dials[0].disposed).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(dials[0].disposed).toBe(true);

    vi.useRealTimers();
    await withPooledSftp(creds, async () => null);
    expect(dials).toHaveLength(2);
  });

  it("does not close a connection while an operation is in flight", async () => {
    vi.useFakeTimers();
    const lease = await leaseSftp(creds);

    vi.advanceTimersByTime(120_000);
    expect(dials[0].disposed).toBe(false);

    lease.release();
    vi.advanceTimersByTime(60_000);
    expect(dials[0].disposed).toBe(true);
  });

  it("treats release as idempotent", async () => {
    vi.useFakeTimers();
    const held = await leaseSftp(creds);
    const other = await leaseSftp(creds);

    // A stream wiring release() to both "close" and "error" must not drop the
    // still-outstanding lease held by another operation.
    held.release();
    held.release();

    vi.advanceTimersByTime(60_000);
    expect(dials[0].disposed).toBe(false);

    other.release();
    vi.advanceTimersByTime(60_000);
    expect(dials[0].disposed).toBe(true);
  });

  it("does not cache a failed dial", async () => {
    const bad = { ...creds, password: "wrong" };
    await expect(leaseSftp(bad)).rejects.toThrow(
      "All configured authentication methods failed"
    );
    await expect(leaseSftp(bad)).rejects.toThrow(
      "All configured authentication methods failed"
    );

    expect(dials).toHaveLength(2);
  });

  it("bounds the handshake and enables keepalive", async () => {
    await withPooledSftp(creds, async () => null);

    expect(dials[0].connectOptions).toMatchObject({
      readyTimeout: 5000,
      keepaliveInterval: 15_000,
    });
  });
});
