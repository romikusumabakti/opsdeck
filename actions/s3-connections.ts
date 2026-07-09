"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAdmin, requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import {
  type NewS3Connection,
  type S3Connection,
  type SafeS3Connection,
  s3Connections,
} from "@/lib/db/schema";
import { testS3Connection } from "@/lib/explorer/s3";
import {
  s3ConnectionInputSchema,
  s3ConnectionUpdateSchema,
} from "@/lib/validation";

// Admin-managed S3-compatible targets for the storage explorer. Mirrors
// actions/servers.ts. `secretKey` is stripped before any row reaches the client.

function toSafe(row: S3Connection): SafeS3Connection {
  const { secretKey, ...rest } = row;
  return { ...rest, hasSecret: secretKey.length > 0 };
}

type CreateResponse =
  | { success: true; data: SafeS3Connection; message?: string }
  | { success: false; message: string };

type SimpleResponse =
  | { success: true; message?: string }
  | { success: false; message: string };

export async function getS3Connections(): Promise<SafeS3Connection[]> {
  await requireSession();
  const rows = await db
    .select()
    .from(s3Connections)
    .orderBy(s3Connections.name);
  return rows.map(toSafe);
}

export async function getS3Connection(
  id: string
): Promise<SafeS3Connection | undefined> {
  await requireSession();
  const [row] = await db
    .select()
    .from(s3Connections)
    .where(eq(s3Connections.id, id))
    .limit(1);
  return row ? toSafe(row) : undefined;
}

export async function createS3Connection(
  data: NewS3Connection
): Promise<CreateResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const parsed = s3ConnectionInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: t("invalidInput") };
  }
  try {
    const [created] = await db
      .insert(s3Connections)
      .values(parsed.data)
      .returning();
    revalidatePath("/storage");
    return { success: true, data: toSafe(created), message: t("s3Created") };
  } catch (error) {
    console.error("Failed to create S3 connection:", error);
    return { success: false, message: t("s3CreateFailed") };
  }
}

export async function updateS3Connection(
  id: string,
  data: Partial<NewS3Connection>
): Promise<SimpleResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const parsed = s3ConnectionUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: t("invalidInput") };
  }
  // Empty/omitted secretKey means "keep the stored one" — drop it from the set.
  const patch = { ...parsed.data };
  if (!patch.secretKey) delete patch.secretKey;
  try {
    const [updated] = await db
      .update(s3Connections)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(s3Connections.id, id))
      .returning();
    if (!updated) {
      return { success: false, message: t("s3NotFound") };
    }
    revalidatePath("/storage");
    revalidatePath(`/storage/${id}`);
    return { success: true, message: t("s3Updated") };
  } catch (error) {
    console.error(`Failed to update S3 connection ${id}:`, error);
    return { success: false, message: t("s3UpdateFailed") };
  }
}

export async function deleteS3Connection(id: string): Promise<SimpleResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  try {
    await db.delete(s3Connections).where(eq(s3Connections.id, id));
    revalidatePath("/storage");
    return { success: true, message: t("s3Deleted") };
  } catch (error) {
    console.error(`Failed to delete S3 connection ${id}:`, error);
    return { success: false, message: t("s3DeleteFailed") };
  }
}

// Probe a connection without persisting. In edit mode the secret may be omitted;
// the stored one is loaded by id — mirrors testServerConnection.
export async function testS3ConnectionAction(input: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretKey?: string;
  forcePathStyle: boolean;
  connectionId?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");

  let secretKey = input.secretKey;
  if (!secretKey && input.connectionId != null) {
    const [row] = await db
      .select({ secretKey: s3Connections.secretKey })
      .from(s3Connections)
      .where(eq(s3Connections.id, input.connectionId))
      .limit(1);
    if (!row) return { ok: false, message: t("s3NotFound") };
    secretKey = row.secretKey;
  }
  if (!secretKey) {
    return { ok: false, message: t("s3SecretRequiredForTest") };
  }

  return testS3Connection({
    endpoint: input.endpoint.trim(),
    region: input.region.trim(),
    bucket: input.bucket.trim(),
    accessKeyId: input.accessKeyId.trim(),
    secretKey,
    forcePathStyle: input.forcePathStyle,
  });
}
