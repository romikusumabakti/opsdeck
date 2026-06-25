import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { imgproxyUrl } from "@/lib/imgproxy";
import { knowledgeIdSchema } from "@/lib/validation";

/**
 * Serve an attachment. The markdown body links here by stable id (never a raw
 * storage/imgproxy URL), so the bucket and imgproxy both stay private and every
 * read is session-gated. We resolve id -> storage key, sign an imgproxy URL, and
 * proxy the transformed result back — the browser only ever talks to the app.
 *
 * The browser's Accept header is forwarded so imgproxy can negotiate the best
 * format it supports (AVIF, then WebP, then the original).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  await requireSession();

  const { id } = await params;
  if (!knowledgeIdSchema.safeParse(id).success) {
    return new Response("Bad request", { status: 400 });
  }

  const row = await db.query.knowledgeAttachments.findFirst({
    where: { id },
    columns: { storageKey: true, mime: true },
  });
  if (!row) return new Response("Not found", { status: 404 });

  let upstream: Response;
  try {
    upstream = await fetch(imgproxyUrl(row.storageKey), {
      headers: { Accept: request.headers.get("accept") ?? "image/*" },
    });
  } catch (error) {
    console.error(`imgproxy fetch failed for ${id}:`, error);
    return new Response("Image service error", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    console.error(`imgproxy returned ${upstream.status} for ${id}`);
    return new Response("Image service error", { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? row.mime,
      // Auth-gated but immutable bytes (key is a uuid); reuse within the session.
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": "inline",
    },
  });
}
