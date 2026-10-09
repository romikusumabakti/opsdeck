// Pure avatar URL helpers, shared by the server routes and <UserAvatar>.
// The URL carries a content hash, so a changed picture is a new URL and the
// served bytes can be cached as immutable.

export const AVATAR_SIZES: readonly number[] = [24, 32, 40, 64, 96, 128, 256];
export const AVATAR_HASH_RE = /^[0-9a-f]{16}$/;
const URL_RE = /^\/api\/avatars\/[0-9a-f-]{36}\/([0-9a-f]{16})$/;

export function snapAvatarSize(
  raw: string | number | null | undefined
): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return 64;
  return AVATAR_SIZES.find((s) => s >= n) ?? 256;
}

export const avatarKey = (userId: string, hash: string) =>
  `avatars/${userId}/${hash}`;
export const avatarUrl = (userId: string, hash: string) =>
  `/api/avatars/${userId}/${hash}`;

export function hashFromAvatarUrl(
  image: string | null | undefined
): string | null {
  return image?.match(URL_RE)?.[1] ?? null;
}

/**
 * True only for the URL our own avatar store minted for this user. Anything
 * else in `users.image` (a foreign URL written through some other path) is
 * never handed to a viewer's browser.
 */
export function isOwnAvatarUrl(
  image: string | null | undefined,
  userId: string
): image is string {
  const hash = hashFromAvatarUrl(image);
  return hash !== null && image === avatarUrl(userId, hash);
}

export function avatarSrc(image: string, px: number): string {
  return `${image}?s=${snapAvatarSize(px)}`;
}
