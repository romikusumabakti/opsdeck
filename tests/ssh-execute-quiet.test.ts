import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteCommandError } from "@/lib/remote-command-error";

// executeRemoteCommand logs a failure (stdout included) unless the caller
// passes `quiet`, for output that may be a secret file's content.

const state = vi.hoisted(() => ({
  result: { code: 0 as number | null, stdout: "", stderr: "" },
}));

class FakeSSH {
  async execCommand() {
    return state.result;
  }
  dispose() {}
}

vi.mock("@/lib/ssh-session", () => ({
  openSsh: async () => new FakeSSH(),
}));

const { executeRemoteCommand } = await import("@/lib/ssh");

const creds = {
  serverId: null,
  host: "host.example.test",
  username: "ops",
  password: "pw",
  auth: "password" as const,
};

let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.result = { code: 0, stdout: "", stderr: "" };
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  error.mockRestore();
});

describe("executeRemoteCommand quiet", () => {
  it("logs a failing command's output by default", async () => {
    state.result = { code: 2, stdout: "FAKE_SECRET=x", stderr: "" };
    await expect(executeRemoteCommand(creds, "false")).rejects.toBeInstanceOf(
      RemoteCommandError
    );
    expect(error).toHaveBeenCalled();
  });

  it("logs nothing when quiet, and still throws the exit error", async () => {
    state.result = { code: 2, stdout: "FAKE_SECRET=x", stderr: "" };
    await expect(
      executeRemoteCommand(creds, "false", { quiet: true })
    ).rejects.toBeInstanceOf(RemoteCommandError);
    expect(error).not.toHaveBeenCalled();
  });

  it("returns stdout on success when quiet", async () => {
    state.result = { code: 0, stdout: "OK", stderr: "" };
    await expect(
      executeRemoteCommand(creds, "true", { quiet: true })
    ).resolves.toBe("OK");
  });
});
