import "server-only";

import { auth } from "@/lib/auth";
import { storeAvatar } from "@/lib/avatars";
import { db } from "@/lib/db";

export type ImportResult = "imported" | "unchanged" | "skipped" | "no_photo" | "no_account";

const PHOTO_URL = "https://graph.microsoft.com/v1.0/me/photos/240x240/$value";

/**
 * Copy the user's Microsoft 365 photo into our avatar store. Runs after every
 * Microsoft sign-in, so a photo changed in M365 follows. An uploaded or
 * deliberately removed avatar is left alone unless `force` (the "Use Microsoft
 * photo" button). Identical bytes hash to the same key, so a re-import is a
 * no-op write.
 */
export async function importMicrosoftAvatar(
  userId: string,
  { force = false }: { force?: boolean } = {}
): Promise<ImportResult> {
  const user = await db.query.users.findFirst({
    where: { id: userId },
    columns: { avatarSource: true, image: true },
  });
  if (!user) return "skipped";
  if (!force && user.avatarSource !== null && user.avatarSource !== "microsoft") return "skipped";

  const account = await db.query.accounts.findFirst({
    where: { userId, providerId: "microsoft" },
    columns: { id: true },
  });
  if (!account) return "no_account";

  // Refreshes the token if it is about to expire.
  const { accessToken } = await auth.api.getAccessToken({
    body: { accountId: account.id, userId },
  });
  const res = await fetch(PHOTO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return "no_photo";
  if (!res.ok) throw new Error(`Graph photo request failed: ${res.status}`);

  const before = user.image;
  const result = await storeAvatar(userId, Buffer.from(await res.arrayBuffer()), "microsoft");
  if (!result.ok) return "no_photo";
  return result.image === before ? "unchanged" : "imported";
}
