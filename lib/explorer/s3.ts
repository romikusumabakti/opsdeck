import "server-only";

import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { S3Connection } from "@/lib/db/schema";
import { basename, normalizeS3Key } from "./path";
import type { DownloadTarget, ExplorerEntry, StorageBackend } from "./types";

// How long a presigned GET stays valid. Short by design: the URL embeds signed
// credentials, so it is a bearer token for one object — minimise the window.
const PRESIGN_TTL_SECONDS = 300;

// Credentials to probe without persisting — used by the "Test connection"
// button before a row exists. Mirrors testSshConnection in lib/ssh.ts.
export type S3ConnectionProbe = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretKey: string;
  forcePathStyle: boolean;
};

// Verify creds + bucket reachability with a bounded, read-only 1-key list. Never
// throws — returns a discriminated result so the caller can surface the reason.
export async function testS3Connection(
  probe: S3ConnectionProbe
): Promise<{ ok: true } | { ok: false; message: string }> {
  const client = new S3Client({
    endpoint: probe.endpoint,
    region: probe.region,
    forcePathStyle: probe.forcePathStyle,
    credentials: {
      accessKeyId: probe.accessKeyId,
      secretAccessKey: probe.secretKey,
    },
  });
  try {
    await client.send(
      new ListObjectsV2Command({ Bucket: probe.bucket, MaxKeys: 1 })
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, message: (error as Error).message ?? String(error) };
  } finally {
    client.destroy();
  }
}

// S3-compatible backend. One instance per connection row. `Delimiter: "/"` turns
// a flat key namespace into a directory view: keys sharing a prefix up to the
// next slash collapse into a `CommonPrefix` (a "folder"), the rest are files.
export function createS3Backend(conn: S3Connection): StorageBackend {
  const client = new S3Client({
    endpoint: conn.endpoint,
    region: conn.region,
    forcePathStyle: conn.forcePathStyle,
    credentials: {
      accessKeyId: conn.accessKeyId,
      secretAccessKey: conn.secretKey,
    },
  });
  const Bucket = conn.bucket;

  // A prefix for listing: normalized, and ending in "/" (or empty for root).
  const dirPrefix = (p: string): string => {
    const key = normalizeS3Key(p, true).replace(/\/+$/, "");
    return key.length > 0 ? `${key}/` : "";
  };

  // Every key under a prefix, paginated and WITHOUT a delimiter so the whole
  // subtree comes back flat. Used by the recursive folder operations below.
  const allKeys = async (Prefix: string): Promise<string[]> => {
    const keys: string[] = [];
    let ContinuationToken: string | undefined;
    do {
      const res = await client.send(
        new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken })
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      ContinuationToken = res.IsTruncated
        ? res.NextContinuationToken
        : undefined;
    } while (ContinuationToken);
    return keys;
  };

  // DeleteObjects caps at 1000 keys per call.
  const deleteKeys = async (keys: string[]): Promise<void> => {
    for (let i = 0; i < keys.length; i += 1000) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket,
          Delete: {
            Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })),
            Quiet: true,
          },
        })
      );
    }
  };

  // Copy one key, or every key under a prefix. Sequential on purpose: a folder
  // copy is a background-ish operation and firing thousands of concurrent
  // CopyObject calls only invites throttling. Bytes never leave the store.
  const copyTree = async (from: string, to: string): Promise<void> => {
    if (!from.endsWith("/")) {
      await copyKey(from, to);
      return;
    }
    const keys = await allKeys(from);
    for (const key of keys) {
      await copyKey(key, `${to}${key.slice(from.length)}`);
    }
  };

  const copyKey = async (from: string, to: string): Promise<void> => {
    await client.send(
      new CopyObjectCommand({
        Bucket,
        // CopySource must be URL-encoded and bucket-prefixed.
        CopySource: `${Bucket}/${encodeURIComponent(from)}`,
        Key: to,
      })
    );
  };

  return {
    async list(pathInput) {
      const Prefix = dirPrefix(pathInput);
      const entries: ExplorerEntry[] = [];
      let ContinuationToken: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({
            Bucket,
            Prefix,
            Delimiter: "/",
            ContinuationToken,
          })
        );
        for (const cp of res.CommonPrefixes ?? []) {
          if (!cp.Prefix) continue;
          entries.push({
            name: basename(cp.Prefix),
            path: cp.Prefix,
            type: "dir",
          });
        }
        for (const obj of res.Contents ?? []) {
          if (!obj.Key || obj.Key === Prefix) continue; // skip the folder marker
          entries.push({
            name: basename(obj.Key),
            path: obj.Key,
            type: "file",
            sizeBytes: obj.Size,
            modifiedAt: obj.LastModified,
          });
        }
        ContinuationToken = res.IsTruncated
          ? res.NextContinuationToken
          : undefined;
      } while (ContinuationToken);

      entries.sort((a, b) =>
        a.type !== b.type
          ? a.type === "dir"
            ? -1
            : 1
          : a.name.localeCompare(b.name)
      );
      return entries;
    },

    async stat(pathInput) {
      const Key = normalizeS3Key(pathInput);
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key }));
        return {
          name: basename(Key),
          path: Key,
          type: "file",
          sizeBytes: res.ContentLength,
          modifiedAt: res.LastModified,
        };
      } catch {
        return null;
      }
    },

    async readStream(pathInput) {
      const Key = normalizeS3Key(pathInput);
      const res = await client.send(new GetObjectCommand({ Bucket, Key }));
      // The SDK returns a web/Node stream depending on runtime; on Node it is a
      // Readable already. Guard for the union type.
      const body = res.Body;
      if (body instanceof Readable) return body;
      return Readable.fromWeb(body as never);
    },

    async writeStream(pathInput, body) {
      const Key = normalizeS3Key(pathInput);
      await client.send(new PutObjectCommand({ Bucket, Key, Body: body }));
    },

    async downloadTarget(pathInput): Promise<DownloadTarget> {
      const Key = normalizeS3Key(pathInput);
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket, Key }),
        { expiresIn: PRESIGN_TTL_SECONDS }
      );
      return { kind: "presigned", url };
    },

    async remove(pathInput) {
      const Key = normalizeS3Key(pathInput, true);
      if (!Key.endsWith("/")) {
        await client.send(new DeleteObjectCommand({ Bucket, Key }));
        return;
      }
      // A "folder" is just a key prefix, so deleting one means deleting every
      // key beneath it (the zero-byte marker included — it shares the prefix).
      const keys = await allKeys(Key);
      if (keys.length > 0) await deleteKeys(keys);
    },

    async mkdir(pathInput) {
      // S3 has no directories; a zero-byte object with a trailing-slash key is
      // the conventional "folder marker" so an empty folder shows up in listings.
      const Key = `${dirPrefix(pathInput)}`;
      if (!Key) throw new Error("Cannot create the bucket root as a folder");
      await client.send(new PutObjectCommand({ Bucket, Key, Body: "" }));
    },

    async rename(fromInput, toInput) {
      const from = normalizeS3Key(fromInput, true);
      const to = normalizeS3Key(toInput, true);
      // No native rename: copy then delete.
      await copyTree(from, to);
      if (!from.endsWith("/")) {
        await client.send(new DeleteObjectCommand({ Bucket, Key: from }));
        return;
      }
      const keys = await allKeys(from);
      if (keys.length > 0) await deleteKeys(keys);
    },

    async copy(fromInput, toInput) {
      await copyTree(
        normalizeS3Key(fromInput, true),
        normalizeS3Key(toInput, true)
      );
    },
  };
}
