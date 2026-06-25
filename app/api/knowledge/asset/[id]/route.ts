import { Readable } from "node:stream";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { getObjectStream } from "@/lib/storage";
import { knowledgeIdSchema } from "@/lib/validation";

/**
 * Serve an attachment's bytes. The markdown body links here by stable id (never
 * a presigned URL, which would expire), so the bucket stays private and every
 * read is session-gated. Resolves id -> storage key -> streamed object.
 */
export async function GET(
  _request: Request,
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

  let body: Readable;
  try {
    body = await getObjectStream(row.storageKey);
  } catch (error) {
    console.error(`Failed to read attachment ${id}:`, error);
    return new Response("Storage error", { status: 502 });
  }

  return new Response(Readable.toWeb(body) as ReadableStream, {
    headers: {
      "Content-Type": row.mime,
      // Private cache: it's auth-gated content, but the bytes are immutable
      // (key is a uuid), so the browser may reuse them within the session.
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": "inline",
    },
  });
}
