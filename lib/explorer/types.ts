import type { Readable } from "node:stream";

// One entry in a directory listing. Backend-neutral: an S3 `CommonPrefix` and
// an SFTP directory both map to `{ type: "dir" }`; an object and a regular file
// both map to `{ type: "file" }`. The explorer UI renders this shape identically
// regardless of which backend produced it.
export type ExplorerEntry = {
  // Display name: the final path segment (no trailing slash for dirs).
  name: string;
  // Full path from the backend root. For S3 this is the object key (dirs end
  // with `/`); for SFTP it is an absolute-ish path under the connection root.
  path: string;
  type: "file" | "dir";
  // Bytes for files; omitted for dirs and when the backend can't report it.
  sizeBytes?: number;
  modifiedAt?: Date;
};

// A resolved place to stream bytes from/to. `presignedUrl` is set only by the
// S3 backend (browser fetches the store directly); SFTP leaves it undefined and
// the caller must proxy through a route using readStream/writeStream.
export type DownloadTarget =
  | { kind: "presigned"; url: string }
  | { kind: "proxy" };

// Backend-neutral file operations. Implementations own credential handling and
// path confinement (see normalizeS3Key / confineSftpPath). Every method takes a
// path that has ALREADY been validated + confined by the caller boundary; the
// backend re-confines defensively but the action layer is the trust boundary.
export interface StorageBackend {
  list(path: string): Promise<ExplorerEntry[]>;
  stat(path: string): Promise<ExplorerEntry | null>;
  // Streams — never buffer a whole file in memory (files may be many GB).
  readStream(path: string): Promise<Readable>;
  writeStream(path: string, body: Readable): Promise<void>;
  // A download handle the action layer hands to the client. S3 returns a
  // short-TTL presigned GET; SFTP returns { kind: "proxy" }.
  downloadTarget(path: string): Promise<DownloadTarget>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  // Duplicate a file or a whole directory tree to `to`. Native where the
  // backend has one (S3 CopyObject never moves bytes through this process);
  // otherwise the implementation streams, which is why it lives on the backend
  // rather than in ops.ts.
  copy(from: string, to: string): Promise<void>;
}
