import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { getObject } from "@/lib/storage";
import { issueIdSchema } from "@/lib/validation";

/**
 * Serve an issue attachment as a download. The row links here by stable id
 * (never a raw storage URL), so the bucket stays private and every read is
 * session-gated. Bytes are streamed as-is with `Content-Disposition: attachment`
 * so no file type can execute inline in the browser.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  await requireSession();

  const { id } = await params;
  if (!issueIdSchema.safeParse(id).success) {
    return new Response("Bad request", { status: 400 });
  }

  const row = await db.query.issueAttachments.findFirst({
    where: { id },
    columns: { storageKey: true, filename: true, mime: true },
  });
  if (!row) return new Response("Not found", { status: 404 });

  let obj: Awaited<ReturnType<typeof getObject>>;
  try {
    obj = await getObject(row.storageKey);
  } catch (error) {
    console.error(`Failed to fetch issue attachment ${id}:`, error);
    return new Response("Storage error", { status: 502 });
  }

  // Both a plain (legacy client) and an RFC 5987 encoded filename so non-ASCII
  // names survive; the sanitizer already stripped quotes/control chars.
  const encoded = encodeURIComponent(row.filename);
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.mime || obj.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${row.filename}"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
