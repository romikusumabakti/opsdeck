import "server-only";

import type { Readable } from "node:stream";
import { NodeSSH } from "node-ssh";
import type { SFTPWrapper, Stats } from "ssh2";
import { basename, confineSftpPath } from "./path";
import type { DownloadTarget, ExplorerEntry, StorageBackend } from "./types";

export type SshCreds = { host: string; username: string; password: string };

// SFTP-over-SSH backend. Reuses the existing `servers` credentials — SFTP is an
// SSH subsystem, no separate auth. `root` confines every path (defence in depth
// on top of the action-layer zod gate): the client can browse anywhere under
// root but never escape it.
//
// Connection lifecycle: a fresh NodeSSH per *operation* (same rationale as
// lib/ssh.ts — a shared client races concurrent callers). Streaming ops keep the
// connection alive until the stream ends, then dispose.
export function createSftpBackend(creds: SshCreds, root = "/"): StorageBackend {
  // Run a one-shot op on a fresh connection, disposing afterwards.
  async function withSftp<T>(
    fn: (sftp: SFTPWrapper) => Promise<T>
  ): Promise<T> {
    const ssh = new NodeSSH();
    try {
      await ssh.connect({ ...creds, readyTimeout: 5000 });
      const sftp = await ssh.requestSFTP();
      return await fn(sftp);
    } finally {
      ssh.dispose();
    }
  }

  const abs = (p: string) => confineSftpPath(root, p);

  return {
    async list(pathInput) {
      const dir = abs(pathInput);
      // Client-facing paths are ROOT-RELATIVE (same convention as the S3
      // backend and the explorer UI): "" is root, dirs carry a trailing slash.
      // The absolute path lives only inside this backend via abs().
      const relBase = pathInput.replace(/^\/+/, "").replace(/\/+$/, "");
      return withSftp(
        (sftp) =>
          new Promise<ExplorerEntry[]>((resolve, reject) => {
            sftp.readdir(dir, (err, files) => {
              if (err) return reject(err);
              const entries = files
                .filter((f) => f.filename !== "." && f.filename !== "..")
                .map((f) => {
                  const isDir = f.attrs.isDirectory();
                  const rel = relBase ? `${relBase}/${f.filename}` : f.filename;
                  return {
                    name: f.filename,
                    path: isDir ? `${rel}/` : rel,
                    type: isDir ? "dir" : "file",
                    sizeBytes: isDir ? undefined : f.attrs.size,
                    // ssh2 mtime is epoch seconds.
                    modifiedAt: f.attrs.mtime
                      ? new Date(f.attrs.mtime * 1000)
                      : undefined,
                  } satisfies ExplorerEntry;
                });
              entries.sort((a, b) =>
                a.type !== b.type
                  ? a.type === "dir"
                    ? -1
                    : 1
                  : a.name.localeCompare(b.name)
              );
              resolve(entries);
            });
          })
      );
    },

    async stat(pathInput) {
      const p = abs(pathInput);
      return withSftp(
        (sftp) =>
          new Promise<ExplorerEntry | null>((resolve) => {
            sftp.stat(p, (err, attrs: Stats) => {
              if (err) return resolve(null);
              const isDir = attrs.isDirectory();
              resolve({
                name: basename(p),
                path: isDir ? `${p}/` : p,
                type: isDir ? "dir" : "file",
                sizeBytes: isDir ? undefined : attrs.size,
                modifiedAt: attrs.mtime
                  ? new Date(attrs.mtime * 1000)
                  : undefined,
              });
            });
          })
      );
    },

    async readStream(pathInput) {
      const p = abs(pathInput);
      // The connection must outlive the stream. Open it, hand back the read
      // stream, and dispose once the stream closes/errors.
      const ssh = new NodeSSH();
      await ssh.connect({ ...creds, readyTimeout: 5000 });
      const sftp = await ssh.requestSFTP();
      const stream = sftp.createReadStream(p);
      const dispose = () => ssh.dispose();
      stream.once("close", dispose);
      stream.once("error", dispose);
      return stream as unknown as Readable;
    },

    async writeStream(pathInput, body) {
      const p = abs(pathInput);
      await withSftp(
        (sftp) =>
          new Promise<void>((resolve, reject) => {
            const out = sftp.createWriteStream(p);
            out.once("close", resolve);
            out.once("error", reject);
            body.once("error", reject);
            body.pipe(out);
          })
      );
    },

    // SFTP has no credentialed URL; the caller proxies bytes through a route.
    async downloadTarget(): Promise<DownloadTarget> {
      return { kind: "proxy" };
    },

    async remove(pathInput) {
      const p = abs(pathInput);
      await withSftp(
        (sftp) =>
          new Promise<void>((resolve, reject) => {
            // Directory paths end with "/"; rmdir them, unlink files.
            const isDir = pathInput.endsWith("/");
            const op = isDir ? sftp.rmdir.bind(sftp) : sftp.unlink.bind(sftp);
            op(p, (err) => (err ? reject(err) : resolve()));
          })
      );
    },

    async mkdir(pathInput) {
      const p = abs(pathInput);
      await withSftp(
        (sftp) =>
          new Promise<void>((resolve, reject) => {
            sftp.mkdir(p, (err) => (err ? reject(err) : resolve()));
          })
      );
    },

    async rename(fromInput, toInput) {
      const from = abs(fromInput);
      const to = abs(toInput);
      await withSftp(
        (sftp) =>
          new Promise<void>((resolve, reject) => {
            sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
          })
      );
    },
  };
}
