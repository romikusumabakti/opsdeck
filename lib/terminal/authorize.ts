import { confineSftpPath, PathError } from "@/lib/explorer/path";

// Characters that would end the single-quoted `cd '<path>'` line the sidecar
// writes to the pty, or start a second command. The quoting already holds for
// everything else, so this is a belt-and-braces check on the one byte that
// matters plus the newline that would submit a second line.
const UNSAFE_CWD = /['\n\r\0]/;

// Resolve the requested working directory against the server's configured sftp
// root. Runs on the mint side so the ticket the sidecar receives is already
// authorized — the sidecar never makes a path decision.
//
// A rejected path is a 400, deliberately, rather than a silent fall back to the
// root: "open a terminal here" quietly landing somewhere else is worse than an
// error, because the next command runs against the wrong directory.
export function resolveTerminalCwd(
  sftpRoot: string,
  requested: string | undefined
): { ok: true; cwd: string } | { ok: false } {
  if (!requested) return { ok: true, cwd: "" };
  if (UNSAFE_CWD.test(requested)) return { ok: false };
  try {
    const confined = confineSftpPath(sftpRoot, requested);
    // Explorer dir paths carry a trailing slash; `cd` does not care, but the
    // audit log and the ticket read better without it. Keep "/" intact.
    const cwd = confined.length > 1 ? confined.replace(/\/+$/, "") : confined;
    return { ok: true, cwd };
  } catch (error) {
    if (error instanceof PathError) return { ok: false };
    throw error;
  }
}
