import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { routeOrgGuard } from "@/lib/authz";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import { knowledgeAttachments } from "@/lib/db/schema";
import { sniffImage } from "@/lib/image-sniff";
import { putObject } from "@/lib/storage";
import { KNOWLEDGE_IMAGE_MAX_BYTES } from "@/lib/validation";

/**
 * Upload an image attachment. Through-app so auth is enforced here. The ORIGINAL
 * bytes are stored as-is in Garage; resizing/format conversion happens on read
 * via imgproxy (see the GET route). The app keeps no image-processing code.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = await routeOrgGuard({ knowledge: ["write"] });
  if (!guard.ok) return guard.response;
  const { session } = guard;

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

  const row = one(
    await db
      .insert(knowledgeAttachments)
      .values({
        storageKey,
        mime: kind.mime,
        sizeBytes: bytes.byteLength,
        uploadedById: session.user.id,
      })
      .returning({ id: knowledgeAttachments.id }),
    "knowledge attachment"
  );

  return NextResponse.json({
    id: row.id,
    url: `/api/knowledge/asset/${row.id}`,
  });
}
