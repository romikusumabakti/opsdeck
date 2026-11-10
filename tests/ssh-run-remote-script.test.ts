import { beforeEach, describe, expect, it, vi } from "vitest";

// runRemoteScript reports the exit code instead of throwing, logs nothing,
// and still disposes the client and enforces its timeout.

const calls: unknown[][] = [];
const state = vi.hoisted(() => ({
  result: { code: 0 as number | null, stdout: "", stderr: "" },
  hang: false,
}));

class FakeSSH {
  async connect(options: Record<string, unknown>) {
    calls.push(["connect", options.host]);
  }
  async execCommand(command: string, options?: { stdin?: string }) {
    calls.push(["exec", command, options?.stdin]);
    if (state.hang) return new Promise(() => {});
    return state.result;
  }
  dispose() {
    calls.push(["dispose"]);
  }
}

vi.mock("node-ssh", () => ({ NodeSSH: FakeSSH }));

const { runRemoteScript } = await import("@/lib/ssh");

const creds = {
  serverId: null,
  host: "10.0.0.5",
  username: "ops",
  password: "pw",
  auth: "password" as const,
};

beforeEach(() => {
  calls.length = 0;
  state.result = { code: 0, stdout: "", stderr: "" };
  state.hang = false;
});

describe("runRemoteScript", () => {
  it("returns a non-zero exit with its output, logging nothing", async () => {
    state.result = { code: 10, stdout: "state stack\n", stderr: "secret=1" };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runRemoteScript(creds, "sh -c 'exit 10'", { timeoutMs: 1000 })
    ).resolves.toEqual({
      code: 10,
      stdout: "state stack\n",
      stderr: "secret=1",
    });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
    expect(calls.at(-1)).toEqual(["dispose"]);
  });

  it("passes stdin", async () => {
    await runRemoteScript(creds, "cat", { timeoutMs: 1000, stdin: "pw\n" });
    expect(calls).toContainEqual(["exec", "cat", "pw\n"]);
  });

  it("times out and disposes", async () => {
    state.hang = true;
    await expect(
      runRemoteScript(creds, "sleep 99", { timeoutMs: 20 })
    ).rejects.toThrow("timed out");
    expect(calls.at(-1)).toEqual(["dispose"]);
  });
});
