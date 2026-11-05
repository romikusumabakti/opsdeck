import { beforeEach, describe, expect, it, vi } from "vitest";

// uploadRemoteContent writes secrets (a rendered .env), so the order of SFTP
// calls is the contract: the file is opened with the mode, chmod'ed through
// the handle (an existing file keeps its old mode on open) BEFORE any data is
// written, and the content never becomes part of a command.

type Call = [string, ...unknown[]];
const calls: Call[] = [];
let failWrite = false;
let hangOpen = false;
type Callback = (err: Error | null, value?: unknown) => void;

const fakeSftp = {
  open(path: string, flags: string, attrs: unknown, cb: Callback) {
    calls.push(["open", path, flags, attrs]);
    if (hangOpen) return;
    cb(null, Buffer.from("h1"));
  },
  fchmod(handle: Buffer, mode: number, cb: Callback) {
    calls.push(["fchmod", handle.toString(), mode]);
    cb(null);
  },
  write(
    handle: Buffer,
    buf: Buffer,
    off: number,
    len: number,
    pos: number,
    cb: Callback
  ) {
    calls.push(["write", handle.toString(), buf.toString(), off, len, pos]);
    cb(failWrite ? new Error("disk full") : null);
  },
  close(handle: Buffer, cb: Callback) {
    calls.push(["close", handle.toString()]);
    cb(null);
  },
  end() {
    calls.push(["end"]);
  },
};

class FakeSSH {
  async connect(options: Record<string, unknown>) {
    calls.push(["connect", options.host]);
  }
  async requestSFTP() {
    return fakeSftp;
  }
  async execCommand(command: string) {
    calls.push(["exec", command]);
    return { code: 0, stdout: "", stderr: "" };
  }
  dispose() {
    calls.push(["dispose"]);
  }
}

vi.mock("node-ssh", () => ({ NodeSSH: FakeSSH }));

const { uploadRemoteContent } = await import("@/lib/ssh");

const creds = { host: "10.0.0.5", username: "ops", password: "pw" };

beforeEach(() => {
  calls.length = 0;
  failWrite = false;
  hangOpen = false;
});

describe("uploadRemoteContent", () => {
  it("opens with the mode, chmods the handle, then writes, closes and disposes", async () => {
    await uploadRemoteContent(creds, "SECRET='x'\n", "/srv/a/.env.new", 0o600);

    expect(calls.map((c) => c[0])).toEqual([
      "connect",
      "open",
      "fchmod",
      "write",
      "close",
      "end",
      "dispose",
    ]);
    expect(calls[1]).toEqual(["open", "/srv/a/.env.new", "w", { mode: 0o600 }]);
    expect(calls[2]).toEqual(["fchmod", "h1", 0o600]);
    expect(calls[3]).toEqual(["write", "h1", "SECRET='x'\n", 0, 11, 0]);
    expect(calls.some((c) => c[0] === "exec")).toBe(false);
  });

  it("writes multi-byte content by byte length", async () => {
    await uploadRemoteContent(creds, "A='é'\n", "/srv/a/f", 0o600);
    const write = calls.find((c) => c[0] === "write");
    expect(write?.[4]).toBe(Buffer.byteLength("A='é'\n"));
  });

  it("a failed write rejects but still closes the handle and disposes", async () => {
    failWrite = true;
    await expect(
      uploadRemoteContent(creds, "x\n", "/srv/a/f", 0o600)
    ).rejects.toThrow("disk full");
    const names = calls.map((c) => c[0]);
    expect(names).toContain("close");
    expect(names.at(-1)).toBe("dispose");
  });

  it("a stuck SFTP operation fails with a fixed message and disposes", async () => {
    hangOpen = true;
    await expect(
      uploadRemoteContent(creds, "x\n", "/srv/a/f", 0o600, 20)
    ).rejects.toThrow("SFTP upload timed out after 20ms");
    expect(calls.at(-1)?.[0]).toBe("dispose");
  });
});
