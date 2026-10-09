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

export function avatarSrc(image: string, px: number): string {
  return `${image}?s=${snapAvatarSize(px)}`;
}
