import { NodeSSH } from "node-ssh";
import type { ClientChannel } from "ssh2";

export async function executeRemoteCommand(
  {
    host,
    username,
    password,
  }: { host: string; username: string; password: string },
  command: string
) {
  // Fresh client per call: a shared singleton races when concurrent callers
  // (e.g. parallel worker jobs, overlapping backup/restore requests) all
  // connect/dispose the same instance and tear down each other's session.
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host, username, password });

    const result = await ssh.execCommand(command);

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
    console.error("SSH Error:", error);
    throw error;
  } finally {
    ssh.dispose();
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
  {
    host,
    username,
    password,
  }: { host: string; username: string; password: string },
  command: string,
  handlers: SshStreamHandlers
): Promise<SshStreamHandle> {
  const ssh = new NodeSSH();
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

  await ssh.connect({ host, username, password });

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
 * Uses a fresh NodeSSH instance so it doesn't conflict with the singleton used
 * for `executeRemoteCommand`. Times out after 5s instead of hanging.
 */
export async function testSshConnection({
  host,
  username,
  password,
}: {
  host: string;
  username: string;
  password: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const client = new NodeSSH();
  try {
    await client.connect({
      host,
      username,
      password,
      readyTimeout: 5000,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: (error as Error).message ?? String(error) };
  } finally {
    client.dispose();
  }
}
