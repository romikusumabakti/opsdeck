import { describe, expect, it } from "vitest";
import { RemoteCommandError } from "@/lib/remote-command-error";

describe("RemoteCommandError", () => {
  it("keeps the SSH Command Failed message with stderr before stdout", () => {
    const err = new RemoteCommandError(2, "out line", "err line");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("SSH Command Failed (exit 2): err line\nout line");
    expect(err.code).toBe(2);
    expect(err.stdout).toBe("out line");
    expect(err.stderr).toBe("err line");
  });

  it("says no output when both streams are empty", () => {
    expect(new RemoteCommandError(null, "", "  ").message).toBe(
      "SSH Command Failed (exit none): (no output)"
    );
  });
});
