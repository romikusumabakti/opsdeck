import "server-only";

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { avatarKey, avatarUrl, hashFromAvatarUrl } from "@/lib/avatar-url";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { sniffImage } from "@/lib/image-sniff";
import { deleteObject, putObject } from "@/lib/storage";

// Avatars are stored as uploaded (imgproxy crops and re-encodes on read) under
// avatars/<userId>/<hash>. GIF is refused: animated avatars are noise in lists.

async function currentImage(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ image: users.image })
    .from(users)
    .where(eq(users.id, userId));
  return row?.image ?? null;
}

async function dropObject(userId: string, hash: string | null) {
  if (!hash) return;
  // An orphan is harmless; never fail the request over it.
  await deleteObject(avatarKey(userId, hash)).catch((error) =>
    console.error(`avatar cleanup failed for ${userId}/${hash}:`, error)
  );
}

export async function storeAvatar(
  userId: string,
  bytes: Buffer,
  source: "upload" | "microsoft"
): Promise<
  { ok: true; image: string } | { ok: false; error: "unsupported_type" }
> {
  const kind = sniffImage(bytes);
  if (!kind || kind.mime === "image/gif")
    return { ok: false, error: "unsupported_type" };

  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const image = avatarUrl(userId, hash);
  const previous = await currentImage(userId);

  // Always written: the key is content-hashed, so a re-put is idempotent and
  // re-uploading the same picture repairs an object that went missing.
  await putObject(avatarKey(userId, hash), bytes, kind.mime);
  await db
    .update(users)
    .set({ image, avatarSource: source, updatedAt: new Date() })
    .where(eq(users.id, userId));

  const oldHash = hashFromAvatarUrl(previous);
  if (oldHash !== hash) await dropObject(userId, oldHash);
  return { ok: true, image };
}

export async function removeAvatar(userId: string): Promise<void> {
  const previous = await currentImage(userId);
  await db
    .update(users)
    .set({ image: null, avatarSource: "removed", updatedAt: new Date() })
    .where(eq(users.id, userId));
  await dropObject(userId, hashFromAvatarUrl(previous));
}
