import { getServerSession } from "@/lib/auth-session";
import { AVATAR_HASH_RE, avatarKey, snapAvatarSize } from "@/lib/avatar-url";
import { imgproxyUrl } from "@/lib/imgproxy";
import { uuidSchema } from "@/lib/validation";

/**
 * Serve an avatar at a fixed size. Every signed-in user may see every avatar.
 * The path is content-addressed, so the response is immutable. A superseded
 * hash 404s once its object is deleted and <UserAvatar> falls back to initials.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ userId: string; hash: string }> }
): Promise<Response> {
  const session = await getServerSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { userId, hash } = await params;
  if (!uuidSchema.safeParse(userId).success || !AVATAR_HASH_RE.test(hash)) {
    return new Response("Bad request", { status: 400 });
  }
  const size = snapAvatarSize(new URL(request.url).searchParams.get("s"));

  let upstream: Response;
  try {
    upstream = await fetch(
      imgproxyUrl(avatarKey(userId, hash), { width: size, fill: true }),
      {
        headers: { Accept: request.headers.get("accept") ?? "image/*" },
      }
    );
  } catch (error) {
    console.error(`imgproxy fetch failed for avatar ${userId}/${hash}:`, error);
    return new Response("Image service error", { status: 502 });
  }
  if (upstream.status === 404)
    return new Response("Not found", { status: 404 });
  if (!upstream.ok || !upstream.body) {
    console.error(
      `imgproxy returned ${upstream.status} for avatar ${userId}/${hash}`
    );
    return new Response("Image service error", { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/webp",
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": "inline",
      Vary: "Accept",
    },
  });
}
