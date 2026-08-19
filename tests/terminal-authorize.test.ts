import { describe, expect, it } from "bun:test";
import { resolveTerminalCwd } from "@/lib/terminal/authorize";

describe("resolveTerminalCwd", () => {
  it("returns an empty cwd when none was requested", () => {
    expect(resolveTerminalCwd("/", undefined)).toEqual({ ok: true, cwd: "" });
    expect(resolveTerminalCwd("/home/deploy", "")).toEqual({
      ok: true,
      cwd: "",
    });
  });

  it("confines a requested path under the server's sftp root", () => {
    expect(resolveTerminalCwd("/", "deployments/dplk-membership/")).toEqual({
      ok: true,
      cwd: "/deployments/dplk-membership",
    });
    expect(resolveTerminalCwd("/home/deploy", "app/")).toEqual({
      ok: true,
      cwd: "/home/deploy/app",
    });
  });

  it("rejects a traversal above the root instead of falling back to it", () => {
    expect(resolveTerminalCwd("/home/deploy", "../../etc")).toEqual({
      ok: false,
    });
  });

  it("rejects a path carrying shell metacharacters", () => {
    // The cwd is interpolated into a `cd '<path>'` line written to the pty, so
    // a single quote would break out of the quoting.
    expect(resolveTerminalCwd("/", "a'; rm -rf /; echo '")).toEqual({
      ok: false,
    });
    expect(resolveTerminalCwd("/", "a\nwhoami")).toEqual({ ok: false });
  });
});
