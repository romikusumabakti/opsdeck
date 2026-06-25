import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { knowledgeAttachments } from "@/lib/db/schema";
import { putObject } from "@/lib/storage";
import {
  KNOWLEDGE_IMAGE_MAX_BYTES,
  KNOWLEDGE_IMAGE_MIME,
} from "@/lib/validation";

// Formats sharp may report from sniffing the actual bytes. SVG is intentionally
// absent — even though sharp can parse it, we never accept it (XSS vector).
const ALLOWED_INPUT = new Set(["png", "jpeg", "jpg", "webp", "gif", "avif"]);

/**
 * Upload an image attachment for the knowledge base. Through-app (not presigned)
 * so auth is enforced here and the storage endpoint never faces the browser.
 *
 * Defense in depth: the size cap rejects oversized bodies before processing;
 * sharp parses the bytes (magic-byte sniff — a spoofed extension/Content-Type
 * can't lie about the real format); the result is re-encoded to WebP, which
 * drops EXIF and neutralizes any polyglot/embedded payload. The stored object is
 * always a clean raster.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await requireSession();

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  if (file.size > KNOWLEDGE_IMAGE_MAX_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }

  const input = Buffer.from(await file.arrayBuffer());

  let output: Buffer;
  try {
    const meta = await sharp(input).metadata();
    if (!meta.format || !ALLOWED_INPUT.has(meta.format)) {
      return NextResponse.json({ error: "unsupported_type" }, { status: 415 });
    }
    // animated: true preserves multi-frame GIFs/WebP; static images are
    // unaffected. Metadata (EXIF/GPS/ICC) is dropped by default on re-encode.
    output = await sharp(input, { animated: true }).webp().toBuffer();
  } catch {
    return NextResponse.json({ error: "unsupported_type" }, { status: 415 });
  }

  // Belt-and-suspenders: our output MIME is always WebP and on the allowlist,
  // but assert it so a future encoder change can't silently store something off
  // the list.
  const mime = "image/webp";
  if (!(KNOWLEDGE_IMAGE_MIME as readonly string[]).includes(mime)) {
    return NextResponse.json({ error: "unsupported_type" }, { status: 415 });
  }

  const id = randomUUID();
  const storageKey = `kb/${id}.webp`;

  try {
    await putObject(storageKey, output, mime);
  } catch (error) {
    console.error("Attachment upload to storage failed:", error);
    return NextResponse.json({ error: "storage" }, { status: 502 });
  }

  const [row] = await db
    .insert(knowledgeAttachments)
    .values({
      storageKey,
      mime,
      sizeBytes: output.byteLength,
      uploadedById: session.user.id,
    })
    .returning({ id: knowledgeAttachments.id });

  return NextResponse.json({
    id: row.id,
    url: `/api/knowledge/asset/${row.id}`,
  });
}
