import "server-only";

import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

// Object storage for knowledge-base attachments. Coded against the S3 API so
// the backing store is swappable — the project ships Garage (self-hosted,
// S3-compatible) in compose, but real S3 / SeaweedFS / Ceph work unchanged.
//
// Garage needs path-style addressing (no per-bucket virtual-host DNS), so
// `forcePathStyle: true` is mandatory here.

const globalForS3 = globalThis as unknown as { __s3Client?: S3Client };

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function getClient(): S3Client {
  if (globalForS3.__s3Client) return globalForS3.__s3Client;
  const client = new S3Client({
    endpoint: env("S3_ENDPOINT"),
    region: process.env.S3_REGION ?? "garage",
    forcePathStyle: true,
    credentials: {
      accessKeyId: env("S3_ACCESS_KEY"),
      secretAccessKey: env("S3_SECRET_KEY"),
    },
  });
  globalForS3.__s3Client = client;
  return client;
}

const bucket = () => env("S3_BUCKET");

/** Store an object. `key` is caller-generated (a uuid path) — never user input. */
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

/** Fetch an object's body as a Node stream for the read route to pipe out. */
export async function getObjectStream(key: string): Promise<Readable> {
  const res = await getClient().send(
    new GetObjectCommand({ Bucket: bucket(), Key: key })
  );
  return res.Body as Readable;
}

export async function deleteObject(key: string): Promise<void> {
  await getClient().send(
    new DeleteObjectCommand({ Bucket: bucket(), Key: key })
  );
}
