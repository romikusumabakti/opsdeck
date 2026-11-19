// Where instance backups come from and go to, as S3 object stores: the
// in-network Garage bucket (the source of the attachments mirror) and the
// backup destination of instance_settings (backup_s3_*, its own credentials;
// not an S3 connection row, so no environment can browse it).
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
import {
  type InstanceSettings,
  instanceSettings,
  s3Connections,
} from "@/lib/db/schema";
import { decryptSecret } from "@/lib/secrets";

export interface ObjectStore {
  /** Every object under `prefix`, paginated to the end. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Streams an object into `filePath`; returns its size in bytes. */
  download(key: string, filePath: string): Promise<number>;
  /** An object's bytes as a stream, read as it is consumed. */
  read(key: string): Promise<Readable>;
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
    // Garage returns a multipart object's composite CRC32 without the "-N"
    // suffix, which the SDK's default check compares with the whole body and
    // rejects. Integrity rests on our own checks (release sha256, backup
    // manifest), so the response check runs only where S3 requires it.
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export type BackupDestination = {
  /** Where it points, as saved; environment archives record these. */
  endpoint: string;
  bucket: string;
  /** The folder of the bucket it is confined to; null = the bucket root. */
  keyPrefix: string | null;
  /** Instance backups: keys relative to keyPrefix. */
  store: ObjectStore;
  /**
   * Keys as they are in the bucket: environment archives record theirs whole
   * (keyPrefix included), so a later prefix change doesn't lose them.
   */
  bucketStore: ObjectStore;
  keepDaily: number;
  keepWeekly: number;
};

/**
 * `inner` confined to `prefix` (normalised: no leading "/", one trailing
 * "/"): every key given is put under it, every key listed comes back without
 * it. Keys come from the backup code, never from a request.
 */
export function prefixedStore(
  inner: ObjectStore,
  prefix: string | null
): ObjectStore {
  if (!prefix) return inner;
  return {
    async list(under) {
      return (await inner.list(`${prefix}${under}`))
        .filter((o) => o.key.startsWith(prefix))
        .map((o) => ({ key: o.key.slice(prefix.length), size: o.size }));
    },
    download: (key, filePath) => inner.download(`${prefix}${key}`, filePath),
    read: (key) => inner.read(`${prefix}${key}`),
    upload: (key, filePath) => inner.upload(`${prefix}${key}`, filePath),
    delete: (keys) => inner.delete(keys.map((key) => `${prefix}${key}`)),
  };
}

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
    async read(Key) {
      const res = await client.send(new GetObjectCommand({ Bucket, Key }));
      if (!res.Body) throw new Error("empty object body");
      const body = (
        res.Body as { transformToWebStream(): ReadableStream }
      ).transformToWebStream();
      return Readable.fromWeb(body as never);
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

/** The env a fresh install restores from (install.sh --restore s3://…). */
export const RESTORE_S3_ENV = {
  endpoint: "MENARA_RESTORE_S3_ENDPOINT",
  region: "MENARA_RESTORE_S3_REGION",
  bucket: "MENARA_RESTORE_S3_BUCKET",
  accessKeyId: "MENARA_RESTORE_S3_ACCESS_KEY_ID",
  secretAccessKey: "MENARA_RESTORE_S3_SECRET_ACCESS_KEY",
  forcePathStyle: "MENARA_RESTORE_S3_FORCE_PATH_STYLE",
} as const;

/**
 * The S3 store named by MENARA_RESTORE_S3_*, or null when none of them is
 * set. A fresh install has no destination in its database, so its restore
 * reads the backup from here. Throws when only some are set or a value is
 * malformed; the message names keys, never values.
 */
export function restoreS3Source(
  env: NodeJS.ProcessEnv = process.env,
  extra: Pick<S3ClientConfig, "requestHandler"> = {}
): ObjectStore | null {
  const v = (k: keyof typeof RESTORE_S3_ENV) => env[RESTORE_S3_ENV[k]] ?? "";
  if (Object.values(RESTORE_S3_ENV).every((k) => !env[k])) return null;
  const missing = (
    ["endpoint", "bucket", "accessKeyId", "secretAccessKey"] as const
  )
    .filter((k) => !v(k))
    .map((k) => RESTORE_S3_ENV[k]);
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} not set`);
  }
  if (!/^https?:\/\/[^\s/]+(\/|$)/.test(v("endpoint"))) {
    throw new Error(`${RESTORE_S3_ENV.endpoint} is not an http(s) URL`);
  }
  const pathStyle = v("forcePathStyle") || "true";
  if (pathStyle !== "true" && pathStyle !== "false") {
    throw new Error(`${RESTORE_S3_ENV.forcePathStyle} must be true or false`);
  }
  const client = backupS3Client(
    {
      endpoint: v("endpoint"),
      region: v("region") || "auto",
      forcePathStyle: pathStyle === "true",
      accessKeyId: v("accessKeyId"),
      secretAccessKey: v("secretAccessKey"),
    },
    extra
  );
  return s3ObjectStore(client, v("bucket"));
}

type DestinationSettings = Pick<
  InstanceSettings,
  | "backupS3Endpoint"
  | "backupS3Region"
  | "backupS3Bucket"
  | "backupS3AccessKeyId"
  | "backupS3SecretKey"
  | "backupS3ForcePathStyle"
  | "backupS3KeyPrefix"
  | "backupKeepDaily"
  | "backupKeepWeekly"
>;

/**
 * The destination the settings row names, with its retention (secret key
 * decrypted with SECRETS_KEY, which throws when it can't), or null when none
 * is set and backups stay local.
 */
export function destinationFromSettings(
  row: DestinationSettings,
  /** Tests pass a fake requestHandler here. */
  extra: Pick<S3ClientConfig, "requestHandler"> = {}
): BackupDestination | null {
  const stored = storedBackupDestination(row);
  if (!stored) return null;
  const { endpoint, bucket, keyPrefix } = stored;
  const client = backupS3Client(
    {
      endpoint,
      region: stored.region,
      forcePathStyle: stored.forcePathStyle,
      accessKeyId: stored.accessKeyId,
      secretAccessKey: decryptSecret(stored.secretKey),
    },
    extra
  );
  const bucketStore = s3ObjectStore(client, bucket);
  return {
    endpoint,
    bucket,
    keyPrefix,
    store: prefixedStore(bucketStore, keyPrefix),
    bucketStore,
    keepDaily: row.backupKeepDaily,
    keepWeekly: row.backupKeepWeekly,
  };
}

/** The destination as the client sees it: no secret. */
export type BackupDestinationView = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  forcePathStyle: boolean;
  keyPrefix: string | null;
  secretSet: boolean;
};

/** A settings row's destination with its secret ciphertext, or null. */
export function storedBackupDestination(row: DestinationSettings): {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  forcePathStyle: boolean;
  keyPrefix: string | null;
  secretKey: string;
} | null {
  const {
    backupS3Endpoint: endpoint,
    backupS3Region: region,
    backupS3Bucket: bucket,
    backupS3AccessKeyId: accessKeyId,
    backupS3SecretKey: secretKey,
  } = row;
  if (!endpoint || !region || !bucket || !accessKeyId || !secretKey) {
    return null;
  }
  return {
    endpoint,
    region,
    bucket,
    accessKeyId,
    forcePathStyle: row.backupS3ForcePathStyle,
    keyPrefix: row.backupS3KeyPrefix,
    secretKey,
  };
}

/** The client-safe projection of a settings row's destination. */
export function backupDestinationView(
  row: DestinationSettings
): BackupDestinationView | null {
  const stored = storedBackupDestination(row);
  if (!stored) return null;
  const { secretKey, ...rest } = stored;
  return { ...rest, secretSet: secretKey.length > 0 };
}

/** Today's backup destination (destinationFromSettings of the row). */
export async function loadBackupDestination(): Promise<BackupDestination | null> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  return row ? destinationFromSettings(row) : null;
}

function connectionStore(conn: typeof s3Connections.$inferSelect): ObjectStore {
  const client = backupS3Client({
    endpoint: conn.endpoint,
    region: conn.region,
    forcePathStyle: conn.forcePathStyle,
    accessKeyId: conn.accessKeyId,
    secretAccessKey: decryptSecret(conn.secretKey),
  });
  return s3ObjectStore(client, conn.bucket);
}

/**
 * The object store of one S3 connection (secret key decrypted with
 * SECRETS_KEY), keys used whole; null when the connection is gone. What an
 * environment archive written before the backup destination got its own
 * credentials lives in (environment_archives.s3_connection_id).
 */
export async function loadS3ConnectionStore(
  connectionId: string
): Promise<ObjectStore | null> {
  const [conn] = await db
    .select()
    .from(s3Connections)
    .where(eq(s3Connections.id, connectionId))
    .limit(1);
  return conn ? connectionStore(conn) : null;
}
