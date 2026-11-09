import { type Config, NodeSSH } from "node-ssh";
import type { ClientChannel } from "ssh2";
import {
  type ConnectOptions,
  connectConfig,
  connectError,
  connectSucceeded,
  HostKeyMismatchError,
  type SshTarget,
} from "@/lib/ssh-connect";

export type { SshTarget };

/**
 * Replaces every occurrence of each non-empty secret with `[redacted]`, and
 * any SCRAM-SHA-256 verifier (whole or cut off), so a partial echo of one is
 * caught too.
 */
export function redactSecrets(message: string, secrets: string[]): string {
  let out = message.replace(/SCRAM-SHA-256\$[^'\s]*/g, "[redacted]");
  // Longest first, so a secret that contains another is removed whole.
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

export type SshTuning = Pick<
  Config,
  "readyTimeout" | "keepaliveInterval" | "keepaliveCountMax"
>;

/**
 * A NodeSSH client connected to `target` with the factory's config (host key
 * verified or pinned, key or password). The caller owns it and must dispose
 * it. The only place a NodeSSH client is connected.
 */
export async function openSsh(
  target: SshTarget,
  tuning: SshTuning = {},
  options: ConnectOptions = {}
): Promise<NodeSSH> {
  const config = await connectConfig(target, options);
  const ssh = new NodeSSH();
  try {
    // connectConfig sets privateKey as a string, as node-ssh's Config wants.
    await ssh.connect({ ...config, ...tuning } as Config);
  } catch (error) {
    ssh.dispose();
    throw connectError(config, error);
  }
  connectSucceeded(config);
  return ssh;
}

export type RemoteCommandOptions = {
  timeoutMs?: number;
  stdin?: string;
  secrets?: string[];
};

export async function executeRemoteCommand(
  target: SshTarget,
  command: string,
  // Wall-clock bound on the remote command (a number, or `timeoutMs` in the
  // options form). Defaults to 10s to fail fast on page-render paths
  // (db/backup listing). Callers running commands that legitimately take
  // longer — e.g. `systemctl restart` waiting for a service to come back up —
  // must pass a larger value to avoid a false timeout. `stdin` is written to
  // the command's standard input, for input that must stay out of argv (SQL
  // carrying a password verifier). `secrets` are redacted from the thrown
  // error and the log, since a failing tool may echo its input.
  options: number | RemoteCommandOptions = {}
) {
  const {
    timeoutMs = 10000,
    stdin,
    secrets = [],
  } = typeof options === "number" ? { timeoutMs: options } : options;
  // Fresh client per call: a shared singleton races when concurrent callers
  // (e.g. parallel worker jobs, overlapping backup/restore requests) all
  // connect/dispose the same instance and tear down each other's session.
  let ssh: NodeSSH | undefined;
  try {
    // Bound the SSH handshake so an unreachable/overloaded DB host fails fast
    // (node-ssh defaults to ~20s) instead of hanging a page render on it.
    ssh = await openSsh(target, { readyTimeout: 5000 });

    // ssh2's exec has no command timeout, so race the command against a wall
    // clock and tear the connection down if it overruns — otherwise a stuck
    // remote command (locked psql, slow disk) blocks the caller indefinitely.
    const result = await Promise.race([
      stdin === undefined
        ? ssh.execCommand(command)
        : ssh.execCommand(command, { stdin }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`SSH command timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);

    if (result.code !== 0) {
      // Some tools (sqlcmd, mysql client, etc.) write errors to stdout instead
      // of stderr, so include both streams in the surfaced message — otherwise
      // a non-zero exit shows up as "SSH Command Failed:" with no detail.
      const detail = [result.stderr, result.stdout]
        .map((s) => s?.trim())
        .filter(Boolean)
        .join("\n");
      throw new Error(
        `SSH Command Failed (exit ${result.code}): ${detail || "(no output)"}`
      );
    }

    return result.stdout;
  } catch (error) {
    // Carries no secret, and its code must reach the caller.
    if (error instanceof HostKeyMismatchError) throw error;
    if (secrets.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = new Error(redactSecrets(message, secrets));
      console.error("SSH Error:", redacted.message);
      throw redacted;
    }
    console.error("SSH Error:", error);
    throw error;
  } finally {
    ssh?.dispose();
  }
}

// SFTP a file OFF a remote host to a local path. Fresh client per call (same
// rationale as executeRemoteCommand). The remote path must be readable by the
// SSH user — callers stage container/root-owned files into an SSH-owned temp
// first (see the restore transfer path in lib/jobs/processor).
export async function downloadRemoteFile(
  target: SshTarget,
  remotePath: string,
  localPath: string
): Promise<void> {
  const ssh = await openSsh(target);
  try {
    await ssh.getFile(localPath, remotePath);
  } finally {
    ssh.dispose();
  }
}

// SFTP a local file ONTO a remote host. The destination directory must be
// writable by the SSH user; callers land the file in a temp dir and then move
// it into place with the correct ownership via a follow-up command.
export async function uploadRemoteFile(
  target: SshTarget,
  localPath: string,
  remotePath: string
): Promise<void> {
  const ssh = await openSsh(target);
  try {
    await ssh.putFile(localPath, remotePath);
  } finally {
    ssh.dispose();
  }
}

/**
 * SFTP in-memory content ONTO a remote host, for files that hold secrets (a
 * rendered `.env`): no local temp file, and the content never appears in a
 * command line. The file is created with `mode`, and the open handle is
 * chmod'ed to `mode` before any byte is written — an existing file keeps its
 * old mode on open — so it is never readable by others while it holds the
 * new content.
 */
export async function uploadRemoteContent(
  target: SshTarget,
  content: string,
  remotePath: string,
  mode: number,
  // Wall-clock bound on the whole operation (connect included), like
  // executeRemoteCommand's: a stuck SFTP server must not hang the deploy.
  timeoutMs = 30_000
): Promise<void> {
  let ssh: NodeSSH | undefined;
  let finished = false;

  const transfer = async () => {
    const client = await openSsh(target, { readyTimeout: 5000 });
    // Timed out while connecting: the finally below already ran.
    if (finished) {
      client.dispose();
      return;
    }
    ssh = client;
    const sftp = await client.requestSFTP();
    try {
      const handle = await new Promise<Buffer>((resolve, reject) =>
        sftp.open(remotePath, "w", { mode }, (err, h) =>
          err ? reject(err) : resolve(h)
        )
      );
      let failure: unknown = null;
      try {
        await new Promise<void>((resolve, reject) =>
          sftp.fchmod(handle, mode, (err) => (err ? reject(err) : resolve()))
        );
        const data = Buffer.from(content, "utf8");
        await new Promise<void>((resolve, reject) =>
          sftp.write(handle, data, 0, data.length, 0, (err) =>
            err ? reject(err) : resolve()
          )
        );
      } catch (err) {
        failure = err;
      }
      // Always close the handle; a close error only surfaces when nothing
      // failed before it, so it never masks the first failure.
      const closeError = await new Promise<Error | undefined>((resolve) =>
        sftp.close(handle, (err) => resolve(err ?? undefined))
      );
      if (failure) throw failure;
      if (closeError) throw closeError;
    } finally {
      sftp.end();
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // On timeout, dispose (below) tears the connection down; the abandoned
    // transfer's late rejection is already handled by the race.
    await Promise.race([
      transfer(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`SFTP upload timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    finished = true;
    clearTimeout(timer);
    ssh?.dispose();
  }
}

export type SshStreamHandlers = {
  onChunk: (chunk: Buffer, source: "stdout" | "stderr") => void;
  onClose: (info: { code: number | null; signal: string | null }) => void;
  onError: (err: Error) => void;
};

export type SshStreamHandle = {
  stop: () => void;
};

// Long-lived SSH exec: forwards stdout/stderr chunks to handlers and resolves
// with a `stop` function. Designed for follow-mode commands (`docker logs -f`,
// `kubectl logs -f`, `journalctl -fu`) where the command never exits on its own.
// Closing the channel triggers SIGHUP on the remote side, which terminates the
// follow process; the underlying SSH client is disposed in the same path.
export async function streamRemoteCommand(
  target: SshTarget,
  command: string,
  handlers: SshStreamHandlers
): Promise<SshStreamHandle> {
  const ssh = await openSsh(target);
  let channel: ClientChannel | undefined;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      channel?.close();
    } catch {
      // channel may already be torn down
    }
    try {
      ssh.dispose();
    } catch {
      // already disposed
    }
  };

  // Wait for the channel to open before returning. `execCommand` resolves only
  // when the remote process exits, so we use `onChannel` as the "ready"
  // signal and let the promise run in the background for stdio + final close.
  await new Promise<void>((resolve, reject) => {
    let opened = false;
    ssh
      .execCommand(command, {
        onChannel(ch) {
          channel = ch;
          opened = true;
          resolve();
        },
        onStdout(chunk) {
          handlers.onChunk(chunk, "stdout");
        },
        onStderr(chunk) {
          handlers.onChunk(chunk, "stderr");
        },
      })
      .then((res) => {
        if (!opened) {
          opened = true;
          reject(new Error("SSH stream ended before channel opened"));
          return;
        }
        if (!stopped) handlers.onClose({ code: res.code, signal: res.signal });
      })
      .catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        if (!opened) {
          opened = true;
          reject(e);
          return;
        }
        if (!stopped) handlers.onError(e);
      })
      .finally(() => {
        try {
          ssh.dispose();
        } catch {
          // already disposed
        }
      });
  });

  return { stop };
}

/**
 * Attempt to connect to an SSH server and return whether the credentials work.
 * A mismatched host key comes back with code `hostKeyMismatch`. Times out after
 * 5s instead of hanging.
 */
export async function testSshConnection(
  target: SshTarget,
  options: ConnectOptions = {}
): Promise<
  { ok: true } | { ok: false; message: string; code?: "hostKeyMismatch" }
> {
  try {
    const client = await openSsh(target, { readyTimeout: 5000 }, options);
    client.dispose();
    return { ok: true };
  } catch (error) {
    if (error instanceof HostKeyMismatchError) {
      return { ok: false, message: error.message, code: error.code };
    }
    return { ok: false, message: (error as Error).message ?? String(error) };
  }
}
