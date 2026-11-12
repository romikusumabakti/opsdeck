/**
 * A remote command that exited non-zero, with both streams kept so a caller
 * can show the full output and summarize it. The message keeps the
 * "SSH Command Failed (exit N): …" form callers already match on; stdout is
 * included because some tools (sqlcmd, mysql client) report errors there.
 * Its own module, not lib/ssh, so tests that mock lib/ssh can still build one.
 */
export class RemoteCommandError extends Error {
  constructor(
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string
  ) {
    const detail = [stderr, stdout]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n");
    super(
      `SSH Command Failed (exit ${code ?? "none"}): ${detail || "(no output)"}`
    );
    this.name = "RemoteCommandError";
  }
}
