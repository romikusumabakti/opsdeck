// Where instance backups come from and go to, as S3 object stores: the
// in-network Garage bucket (the source of the attachments mirror) and the
// S3 connection chosen as the backup destination in instance_settings.
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { instanceSettings, s3Connections } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/secrets";

export interface ObjectStore {
  /** Every object under `prefix`, paginated to the end. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Streams an object into `filePath`; returns its size in bytes. */
  download(key: string, filePath: string): Promise<number>;
  /** Streams `filePath` into an object. */
  upload(key: string, filePath: string): Promise<void>;
  delete(keys: string[]): Promise<void>;
}

// 16 MiB parts: up to ~160 GiB within S3's 10 000-part limit.
const PART_SIZE = 16 * 1024 * 1024;

/**
 * An S3 client for backups. The standard retry strategy retries 5xx,
 * network errors and throttling (429, SlowDown) with jittered exponential
 * backoff; five attempts give a busy destination a little more room.
 */
export function backupS3Client(
  config: {
    endpoint: string;
    region: string;
    forcePathStyle: boolean;
    accessKeyId: string;
    secretAccessKey: string;
  },
  /** Tests pass a fake requestHandler here. */
  extra: Pick<S3ClientConfig, "requestHandler"> = {}
): S3Client {
  return new S3Client({
    ...extra,
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    retryMode: "standard",
    maxAttempts: 5,
  });
}

export type BackupDestination = {
  store: ObjectStore;
  keepDaily: number;
  keepWeekly: number;
};

export function s3ObjectStore(client: S3Client, Bucket: string): ObjectStore {
  return {
    async list(Prefix) {
      const objects: { key: string; size: number }[] = [];
      let ContinuationToken: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken })
        );
        for (const o of res.Contents ?? []) {
          if (o.Key) objects.push({ key: o.Key, size: o.Size ?? 0 });
        }
        ContinuationToken = res.IsTruncated
          ? res.NextContinuationToken
          : undefined;
      } while (ContinuationToken);
      return objects;
    },
    async download(Key, filePath) {
      const res = await client.send(new GetObjectCommand({ Bucket, Key }));
      if (!res.Body) throw new Error("empty object body");
      const body = (
        res.Body as { transformToWebStream(): ReadableStream }
      ).transformToWebStream();
      await pipeline(
        Readable.fromWeb(body as never),
        createWriteStream(filePath)
      );
      return (await stat(filePath)).size;
    },
    async upload(Key, filePath) {
      // Multipart above one part, so dumps over 5 GiB work. Each part is a
      // buffer, which the client's retry strategy can resend.
      await new Upload({
        client,
        params: { Bucket, Key, Body: createReadStream(filePath) },
        partSize: PART_SIZE,
        queueSize: 4,
        leavePartsOnError: false,
      }).done();
    },
    async delete(keys) {
      // DeleteObjects takes at most 1000 keys per call.
      for (let i = 0; i < keys.length; i += 1000) {
        const res = await client.send(
          new DeleteObjectsCommand({
            Bucket,
            Delete: {
              Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })),
              Quiet: true,
            },
          })
        );
        if (res.Errors?.length) {
          throw new Error(`DeleteObjects failed for ${res.Errors.length} keys`);
        }
      }
    },
  };
}

/**
 * The app's own Garage bucket (S3_* env, as lib/storage.ts uses it), or null
 * while Garage is not provisioned yet (no keys): there is nothing to mirror.
 */
export function garageSource(
  env: NodeJS.ProcessEnv = process.env
): ObjectStore | null {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    return null;
  }
  const client = backupS3Client({
    endpoint: S3_ENDPOINT,
    region: env.S3_REGION || "garage",
    forcePathStyle: true,
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
  });
  return s3ObjectStore(client, S3_BUCKET);
}

/**
 * The destination chosen in instance_settings with its retention, built from
 * the s3_connections row (secret key decrypted with SECRETS_KEY), or null
 * when none is chosen and backups stay local.
 */
export async function loadBackupDestination(): Promise<BackupDestination | null> {
  const [row] = await db
    .select({
      keepDaily: instanceSettings.backupKeepDaily,
      keepWeekly: instanceSettings.backupKeepWeekly,
      connection: s3Connections,
    })
    .from(instanceSettings)
    .innerJoin(
      s3Connections,
      eq(s3Connections.id, instanceSettings.backupDestinationId)
    )
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  if (!row) return null;
  const conn = row.connection;
  const client = backupS3Client({
    endpoint: conn.endpoint,
    region: conn.region,
    forcePathStyle: conn.forcePathStyle,
    accessKeyId: conn.accessKeyId,
    secretAccessKey: decryptSecret(conn.secretKey),
  });
  return {
    store: s3ObjectStore(client, conn.bucket),
    keepDaily: row.keepDaily,
    keepWeekly: row.keepWeekly,
  };
}
