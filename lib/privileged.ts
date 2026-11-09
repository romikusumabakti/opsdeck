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
