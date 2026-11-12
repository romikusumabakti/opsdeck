import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { ClientChannel } from "ssh2";
import { RemoteCommandError } from "@/lib/remote-command-error";
import {
  type ConnectOptions,
  HostKeyMismatchError,
  type SshTarget,
} from "@/lib/ssh-connect";
import { openSsh, type SshSession } from "@/lib/ssh-session";

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

export { openSsh, type SshTuning } from "@/lib/ssh-session";

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
  let ssh: SshSession | undefined;
  try {
    // Bound the SSH handshake so an unreachable/overloaded DB host fails fast
    // (ssh2's readyTimeout defaults to ~20s) instead of hanging a page render
    // on it.
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
      throw new RemoteCommandError(
        result.code,
        result.stdout ?? "",
        result.stderr ?? ""
      );
    }

    return result.stdout;
  } catch (error) {
    // Carries no secret, and its code must reach the caller.
    if (error instanceof HostKeyMismatchError) throw error;
    if (secrets.length > 0) {
      const redacted =
        error instanceof RemoteCommandError
          ? new RemoteCommandError(
              error.code,
              redactSecrets(error.stdout, secrets),
              redactSecrets(error.stderr, secrets)
            )
          : new Error(
              redactSecrets(
                error instanceof Error ? error.message : String(error),
                secrets
              )
            );
      console.error("SSH Error:", redacted.message);
      throw redacted;
    }
    console.error("SSH Error:", error);
    throw error;
  } finally {
    ssh?.dispose();
  }
}

export type RemoteScriptResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Runs `command` and returns its exit code and output instead of throwing on
 * a non-zero exit, for scripts that report outcomes by exit code. Nothing is
 * logged: the caller decides what of the output is safe to keep (stderr of
 * a compose command can quote the compose file or .env). Connection errors
 * and the wall-clock timeout still throw.
 */
export async function runRemoteScript(
  target: SshTarget,
  command: string,
  options: { timeoutMs: number; stdin?: string }
): Promise<RemoteScriptResult> {
  const { timeoutMs, stdin } = options;
  let ssh: SshSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    ssh = await openSsh(target, { readyTimeout: 5000 });
    const result = await Promise.race([
      stdin === undefined
        ? ssh.execCommand(command)
        : ssh.execCommand(command, { stdin }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`SSH command timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    clearTimeout(timer);
    ssh?.dispose();
  }
}

export type StreamToFileResult = {
  code: number | null;
  /** Bytes of stdout written to the file. */
  bytes: number;
  /** The start of stderr (at most 4 KiB), for the caller to pick from. */
  stderr: string;
};

const STREAM_STDERR_LIMIT = 4096;

/**
 * Connects, execs `command` and hands the open channel to `wire`, which
 * returns the outcome. Owns the scaffold every streaming exec needs: fresh
 * client (5 s handshake bound), a mid-stream connection error failing the
 * call (ssh2 emits a late connection error as an event, not as a
 * rejection), the wall-clock timeout, and dispose. `wire` is not called if
 * the call already settled (timeout before the channel opened). `cleanup`
 * runs in the end, whatever the outcome, for resources the caller opened (a
 * body stream).
 */
async function withExecChannel<T>(
  target: SshTarget,
  command: string,
  timeoutMs: number,
  wire: (channel: ClientChannel) => Promise<T>,
  cleanup: () => void = () => {}
): Promise<T> {
  let ssh: SshSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  try {
    ssh = await openSsh(target, { readyTimeout: 5000 });
    const { client } = ssh;
    const connectionLost = new Promise<never>((_, reject) => {
      client.on("error", reject);
    });
    connectionLost.catch(() => {});
    const work = new Promise<T>((resolve, reject) => {
      client.exec(command, (err, channel) => {
        if (err) {
          reject(err);
          return;
        }
        if (settled) {
          channel.close();
          return;
        }
        // `wire` puts every listener on before returning: ssh2 can emit the
        // exit status in the same tick as this callback.
        wire(channel).then(resolve, reject);
      });
    });
    // On timeout, dispose (below) tears the channel down; the abandoned
    // work's late rejection is already handled by the race.
    work.catch(() => {});
    return await Promise.race([
      work,
      connectionLost,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`SSH command timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    settled = true;
    clearTimeout(timer);
    try {
      cleanup();
    } finally {
      ssh?.dispose();
    }
  }
}

/**
 * Runs `command` and writes its stdout into `filePath` (created 0600) as it
 * arrives, with backpressure, so a dump or tarball never sits in memory.
 * Returns the exit code instead of throwing on a non-zero exit; nothing is
 * logged. `stdin` is written to the command's input and closed (a sudo
 * password, never argv). Connection errors and the wall-clock timeout throw;
 * the file may then hold partial output, which the caller removes.
 */
export function streamRemoteCommandToFile(
  target: SshTarget,
  command: string,
  filePath: string,
  options: { timeoutMs: number; stdin?: string }
): Promise<StreamToFileResult> {
  const { timeoutMs, stdin } = options;
  return withExecChannel(
    target,
    command,
    timeoutMs,
    (channel) =>
      new Promise<StreamToFileResult>((resolve, reject) => {
        let code: number | null = null;
        let stderr = "";
        channel.on("exit", (exitCode: number | null) => {
          code = typeof exitCode === "number" ? exitCode : null;
        });
        const closed = new Promise<void>((done) =>
          channel.on("close", () => done())
        );
        channel.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < STREAM_STDERR_LIMIT) {
            stderr += chunk
              .toString("utf8")
              .slice(0, STREAM_STDERR_LIMIT - stderr.length);
          }
        });
        const written = pipeline(
          channel,
          createWriteStream(filePath, { mode: 0o600 })
        );
        channel.end(stdin);
        written
          .then(() => closed)
          .then(() => stat(filePath))
          .then((file) => resolve({ code, bytes: file.size, stderr }))
          .catch(reject);
      })
  );
}

const PIPE_OUTPUT_LIMIT = 64 * 1024;

/**
 * Runs `command` with `body` piped into its stdin, with backpressure, so a
 * large body (a registry blob) never sits in memory. Resolves with the
 * output on exit code 0; throws with the (redacted) stderr otherwise. If the
 * command exits before the body is consumed (tar failing), or the call fails
 * for any reason, the body stream is cancelled. Fresh connection per call;
 * on timeout the connection is torn down. `secrets` are redacted from every
 * thrown message.
 */
export async function pipeToRemoteCommand(
  target: SshTarget,
  command: string,
  body: ReadableStream<Uint8Array>,
  options: { timeoutMs: number; secrets?: string[] }
): Promise<{ stdout: string; stderr: string }> {
  const { timeoutMs, secrets = [] } = options;
  let source: Readable | undefined;
  try {
    return await withExecChannel(
      target,
      command,
      timeoutMs,
      (channel) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          let code: number | null = null;
          let stdout = "";
          let stderr = "";
          const append = (current: string, chunk: Buffer) =>
            current.length < PIPE_OUTPUT_LIMIT
              ? current +
                chunk
                  .toString("utf8")
                  .slice(0, PIPE_OUTPUT_LIMIT - current.length)
              : current;
          channel.on("data", (chunk: Buffer) => {
            stdout = append(stdout, chunk);
          });
          channel.stderr.on("data", (chunk: Buffer) => {
            stderr = append(stderr, chunk);
          });
          channel.on("exit", (exitCode: number | null) => {
            code = typeof exitCode === "number" ? exitCode : null;
          });
          channel.on("error", reject);
          channel.on("close", () => {
            // The command is over: stop reading the body and cancel it.
            source?.destroy();
            if (code === 0) {
              resolve({ stdout, stderr });
              return;
            }
            reject(new RemoteCommandError(code, stdout, stderr));
          });
          source = Readable.fromWeb(body as unknown as WebReadableStream);
          // Reading the body failed (the registry dropped): fail the call.
          // Destroying the source after a premature close is not an error.
          source.on("error", reject);
          // pipe() honours the channel's backpressure and ends stdin at EOF.
          source.pipe(channel);
        }),
      () => {
        // Never reached the channel (connect/exec failure, timeout first):
        // the body is still unread and must be cancelled by hand.
        if (source) source.destroy();
        else void body.cancel().catch(() => {});
      }
    );
  } catch (error) {
    // Carries no secret, and its code must reach the caller.
    if (error instanceof HostKeyMismatchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(message, secrets));
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
  let ssh: SshSession | undefined;
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
