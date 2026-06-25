import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { knowledgeAttachments } from "@/lib/db/schema";
import { putObject } from "@/lib/storage";
import { KNOWLEDGE_IMAGE_MAX_BYTES } from "@/lib/validation";

// Magic-byte sniff -> { ext, mime }. The bytes are the source of truth, so a
// spoofed extension/Content-Type can't smuggle in a non-image. SVG is rejected
// by omission (active XSS vector); anything imgproxy can't render is rejected on
// serve anyway, but we refuse to even store junk.
function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  const b = buf;
  if (b.length < 12) return null;
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  // GIF: "GIF8"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { ext: "gif", mime: "image/gif" };
  }
  // WebP: "RIFF"...."WEBP"
  if (
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  // AVIF/HEIF: "ftyp" box at offset 4 with an avif/avis brand
  if (b.toString("ascii", 4, 8) === "ftyp") {
    const brand = b.toString("ascii", 8, 12);
    if (brand === "avif" || brand === "avis") {
      return { ext: "avif", mime: "image/avif" };
    }
  }
  return null;
}

/**
 * Upload an image attachment. Through-app so auth is enforced here. The ORIGINAL
 * bytes are stored as-is in Garage; resizing/format conversion happens on read
 * via imgproxy (see the GET route). The app keeps no image-processing code.
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

  const bytes = Buffer.from(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) {
    return NextResponse.json({ error: "unsupported_type" }, { status: 415 });
  }

  const id = randomUUID();
  const storageKey = `kb/${id}.${kind.ext}`;

  try {
    await putObject(storageKey, bytes, kind.mime);
  } catch (error) {
    console.error("Attachment upload to storage failed:", error);
    return NextResponse.json({ error: "storage" }, { status: 502 });
  }

  const [row] = await db
    .insert(knowledgeAttachments)
    .values({
      storageKey,
      mime: kind.mime,
      sizeBytes: bytes.byteLength,
      uploadedById: session.user.id,
    })
    .returning({ id: knowledgeAttachments.id });

  return NextResponse.json({
    id: row.id,
    url: `/api/knowledge/asset/${row.id}`,
  });
}
