import { shq } from "@/lib/sh";

// How a command gets root on a server. A server that moved to the instance key
// has no stored password any more, so sudo can only be fed one in password
// mode; key servers rely on root login or a NOPASSWD sudoers rule.
//   - root: the SSH user already is root; nothing to elevate.
//   - sudo-nopasswd: `sudo -n` fails fast ("a password is required") instead
//     of hanging on a prompt when the sudoers rule is missing.
//   - sudo-password: the stored login password is piped to `sudo -S`, so it
//     never appears in argv (visible in `ps`). That pipe owns the outer
//     shell's stdin; in the other modes stdin is free.
export type PrivilegeMode = "root" | "sudo-nopasswd" | "sudo-password";

export type PrivilegedServer = {
  username: string;
  auth: "password" | "key";
  password: string | null;
};

export function privilegeMode(server: PrivilegedServer): PrivilegeMode {
  if (server.username === "root") return "root";
  if (server.auth === "password" && server.password) return "sudo-password";
  return "sudo-nopasswd";
}

/**
 * `cmd` (shell words, already quoted by the caller) run as root, or as
 * `runAsUser` when set. As root the user switch is util-linux `runuser`
 * (Debian and RHEL both ship it), which takes the command as words like sudo.
 */
export function privileged(
  cmd: string,
  server: PrivilegedServer,
  opts: { runAsUser?: string } = {}
): string {
  const { runAsUser } = opts;
  const sudoUser = runAsUser ? `-u ${shq(runAsUser)} ` : "";
  switch (privilegeMode(server)) {
    case "root":
      return runAsUser ? `runuser -u ${shq(runAsUser)} -- ${cmd}` : cmd;
    case "sudo-nopasswd":
      return `sudo -n ${sudoUser}${cmd}`;
    case "sudo-password":
      // privilegeMode only picks this mode with a non-empty password.
      return `printf '%s\\n' ${shq(server.password as string)} | sudo -S ${sudoUser}${cmd}`;
  }
}

/**
 * As privileged(), but in sudo-password mode the password travels on the
 * command's stdin (`sudo -S -p ''`), so it is never part of the command
 * string. Only for commands that do not read stdin themselves; pass
 * `stdin` to executeRemoteCommand and the password in its `secrets`.
 */
export function privilegedViaStdin(
  cmd: string,
  server: PrivilegedServer
): { command: string; stdin?: string } {
  if (privilegeMode(server) === "sudo-password") {
    return {
      command: `sudo -S -p '' ${cmd}`,
      stdin: `${server.password as string}\n`,
    };
  }
  return { command: privileged(cmd, server) };
}

/**
 * The line privilegedWithStdin puts right before the payload. Fixed, and
 * matched by exact line equality. If an unread password line happened to
 * equal it, the payload would just start one line early with the marker
 * itself. The marker begins with `--`, an SQL comment to psql, so that is
 * harmless.
 */
export const STDIN_PAYLOAD_MARKER =
  "--menara-stdin-payload-7f3c9a2e-4b1d-4e8a-9c6f-0d5e2b8a1c47--";

/**
 * `inner` (a shell script reading its input from stdin) run as root, or as
 * `runAsUser`, in `bash -c`, fed `stdin` without putting any of it in the
 * command string (SQL that holds a secret, say).
 *
 * stdin is `[sudo password line]`, then STDIN_PAYLOAD_MARKER, then `stdin`.
 * The shell drops every line up to and including the marker before `inner`
 * runs, so it never matters whether sudo read its password line: a NOPASSWD
 * rule or a cached timestamp leaves it unread, and it must never reach
 * `inner` (psql would log it in a failed statement). The marker is sent in
 * every mode. Without one, `inner` never runs and the command fails. bash's
 * `read` takes one byte at a time from a pipe, so the payload stays whole.
 * Pass `secrets` to executeRemoteCommand as usual.
 */
export function privilegedWithStdin(
  inner: string,
  server: PrivilegedServer,
  opts: { runAsUser?: string; stdin: string }
): { command: string; stdin: string } {
  const { runAsUser } = opts;
  const script =
    `while IFS= read -r l; do if [ "$l" = ${shq(STDIN_PAYLOAD_MARKER)} ]; then ${inner}\n exit; fi; done; ` +
    `echo 'stdin payload marker missing' >&2; exit 1`;
  const cmd = `bash -c ${shq(script)}`;
  const stdin = `${STDIN_PAYLOAD_MARKER}\n${opts.stdin}`;
  if (privilegeMode(server) === "sudo-password") {
    const sudoUser = runAsUser ? `-u ${shq(runAsUser)} ` : "";
    return {
      command: `sudo -S -p '' ${sudoUser}${cmd}`,
      stdin: `${server.password as string}\n${stdin}`,
    };
  }
  return { command: privileged(cmd, server, { runAsUser }), stdin };
}
