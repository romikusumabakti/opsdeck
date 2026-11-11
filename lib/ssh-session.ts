import {
  Client,
  type ClientChannel,
  type ConnectConfig,
  type SFTPWrapper,
} from "ssh2";
import {
  type ConnectOptions,
  connectConfig,
  connectError,
  connectSucceeded,
  type SshTarget,
} from "@/lib/ssh-connect";

export type SshTuning = Pick<
  ConnectConfig,
  "readyTimeout" | "keepaliveInterval" | "keepaliveCountMax"
>;

export type ExecOptions = {
  // Written to the command's standard input, which is then closed.
  stdin?: string;
  // Keep surrounding whitespace in stdout/stderr (a listing's last newline).
  noTrim?: boolean;
  onChannel?: (channel: ClientChannel) => void;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
};

export type ExecResult = {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

/**
 * An ssh2 client that is connected (see openSsh). The caller owns it and must
 * dispose it. Covers what the app uses of a session: exec, SFTP, file transfer.
 */
export class SshSession {
  private connected = false;
  private disposed = false;

  constructor(readonly client: Client) {
    // ssh2 emits "error" for a connection that dies after it was ready (reset,
    // keepalive timeout). With no listener, EventEmitter throws it as an
    // uncaught exception and takes the process down. Work in flight still
    // fails: the channel closes and the exec/transfer rejects or resolves.
    client.on("error", () => {});
    client.on("ready", () => {
      this.connected = true;
    });
    const gone = () => {
      this.connected = false;
    };
    client.on("end", gone);
    client.on("close", gone);
  }

  execCommand(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      this.client.exec(command, (err, channel) => {
        if (err) {
          reject(err);
          return;
        }
        options.onChannel?.(channel);
        const stdout: string[] = [];
        const stderr: string[] = [];
        let code: number | null = null;
        let signal: string | null = null;
        // Every listener goes on before anything is written: ssh2 can emit
        // the exit status in the same tick as this callback.
        channel.on("data", (chunk: Buffer) => {
          options.onStdout?.(chunk);
          stdout.push(chunk.toString());
        });
        channel.stderr.on("data", (chunk: Buffer) => {
          options.onStderr?.(chunk);
          stderr.push(chunk.toString());
        });
        channel.on("exit", (exitCode?: number | null, exitSignal?: string) => {
          code = exitCode ?? null;
          signal = exitSignal ?? null;
        });
        channel.on("close", () => {
          const out = stdout.join("");
          const errOut = stderr.join("");
          resolve({
            code,
            signal,
            stdout: options.noTrim ? out : out.trim(),
            stderr: options.noTrim ? errOut : errOut.trim(),
          });
        });
        if (options.stdin !== undefined) {
          channel.write(options.stdin);
        }
        channel.end();
      });
    });
  }

  requestSFTP(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
    });
  }

  async getFile(localPath: string, remotePath: string): Promise<void> {
    const sftp = await this.requestSFTP();
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, (err) =>
          err ? reject(err) : resolve()
        );
      });
    } finally {
      sftp.end();
    }
  }

  async putFile(localPath: string, remotePath: string): Promise<void> {
    const sftp = await this.requestSFTP();
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (err) =>
          err ? reject(err) : resolve()
        );
      });
    } finally {
      sftp.end();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.client.end();
  }
}

/**
 * Resolves on ready; rejects on an error or a close before it. Not exported:
 * a session is only ever connected by openSsh, with connectConfig's config.
 */
function connectClient(client: Client, config: ConnectConfig): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      client.off("error", onError);
      client.off("ready", onReady);
      client.off("close", onClose);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("No response from server"));
    };
    client.on("error", onError);
    client.on("ready", onReady);
    client.on("close", onClose);
    client.connect(config);
  });
}

/**
 * An SshSession connected to `target` with the factory's config (host key
 * verified or pinned, key or password). The caller owns it and must dispose
 * it. The only place an ssh2 session is connected.
 */
export async function openSsh(
  target: SshTarget,
  tuning: SshTuning = {},
  options: ConnectOptions = {}
): Promise<SshSession> {
  const config = await connectConfig(target, options);
  const session = new SshSession(new Client());
  try {
    await connectClient(session.client, { ...config, ...tuning });
  } catch (error) {
    session.dispose();
    throw connectError(config, error);
  }
  connectSucceeded(config);
  return session;
}
