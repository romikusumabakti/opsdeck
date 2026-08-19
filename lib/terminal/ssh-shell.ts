import { Client, type ClientChannel } from "ssh2";
import type { ShellHandle } from "@/lib/terminal/session";

// Adapts an ssh2 shell channel to the ShellHandle the session registry expects.
// Kept separate from server.ts so the registry, the message loop, and the SSH
// mechanics can each be reasoned about (and swapped in tests) on their own.

export type ShellTarget = {
  host: string;
  port?: number;
  username: string;
  password: string;
};

export type ShellOptions = {
  cols: number;
  rows: number;
  // Written as `cd '<cwd>'` on open. Already confined and metacharacter-checked
  // by lib/terminal/authorize — never accept an unvalidated value here.
  cwd?: string;
};

export type ShellSession = ShellHandle & {
  onData(cb: (chunk: Uint8Array) => void): void;
  onExit(
    cb: (info: { code: number | null; signal: string | null }) => void
  ): void;
};

export function openSshShell(
  target: ShellTarget,
  options: ShellOptions
): Promise<ShellSession> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(error);
    };

    client.on("error", fail);

    client.on("ready", () => {
      client.shell(
        {
          term: "xterm-256color",
          cols: options.cols,
          rows: options.rows,
          width: options.cols * 8,
          height: options.rows * 16,
        },
        (err: Error | undefined, stream: ClientChannel) => {
          if (err) {
            fail(err);
            return;
          }
          settled = true;

          if (options.cwd) {
            // Single quotes are safe: authorize.ts rejects any cwd containing
            // one, along with newlines.
            stream.write(`cd '${options.cwd}'\n`);
          }

          const handle: ShellSession = {
            write(data) {
              stream.write(Buffer.from(data));
            },
            resize(cols, rows) {
              stream.setWindow(rows, cols, rows * 16, cols * 8);
            },
            close() {
              try {
                stream.end();
              } catch {
                // Channel already gone.
              }
              client.end();
            },
            setFlowing(flowing) {
              // stderr as well: on a server that splits it from stdout, an
              // unpaused stderr walks straight past the 1 MB threshold that
              // exists to stop an unbounded write buffer.
              if (flowing) {
                stream.resume();
                stream.stderr?.resume();
              } else {
                stream.pause();
                stream.stderr?.pause();
              }
            },
            onData(cb) {
              stream.on("data", (chunk: Buffer) => cb(new Uint8Array(chunk)));
              // stderr on a pty channel is normally folded into stdout, but a
              // server that splits them must not silently drop the second half.
              stream.stderr?.on("data", (chunk: Buffer) =>
                cb(new Uint8Array(chunk))
              );
            },
            onExit(cb) {
              let reported = false;
              const report = (code: number | null, signal: string | null) => {
                if (reported) return;
                reported = true;
                cb({ code, signal });
                client.end();
              };
              stream.on("exit", (code: number | null, signal?: string) =>
                report(code, signal ?? null)
              );
              stream.on("close", () => report(null, null));
              client.on("close", () => report(null, null));
            },
          };
          resolve(handle);
        }
      );
    });

    client.connect({
      host: target.host,
      port: target.port ?? 22,
      username: target.username,
      password: target.password,
      // Fail fast on an unreachable host rather than hanging the browser's
      // "connecting…" state for 20s.
      readyTimeout: 8000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
    });
  });
}
