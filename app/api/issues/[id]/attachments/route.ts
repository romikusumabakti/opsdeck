import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { issueAttachments } from "@/lib/db/schema";
import { putObject } from "@/lib/storage";
import { ISSUE_ATTACHMENT_MAX_BYTES, issueIdSchema } from "@/lib/validation";

// Keep only the basename and an allowlist of safe characters, cap length. The
// name is display-only (the object key is a server-generated uuid), but it lands
// in a Content-Disposition header on download, so anything outside word chars,
// dot, dash, and space is collapsed to `_` — no quotes/control chars to escape.
function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const clean = base.replace(/[^\w.\- ]+/g, "_").trim();
  return (clean || "file").slice(0, 255);
}

/**
 * Upload an attachment to an issue. Through-app so auth is enforced here and the
 * bucket stays private. Any file type is accepted (logs, screenshots, PDFs) up
 * to the size ceiling; bytes are stored as-is and served back as a download.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const session = await requireSession();

  const { id } = await params;
  if (!issueIdSchema.safeParse(id).success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Confirm the issue exists before storing bytes, so a bad id can't leave an
  // orphaned object in the bucket.
  const issue = await db.query.issues.findFirst({
    where: { id },
    columns: { id: true },
  });
  if (!issue) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  if (file.size > ISSUE_ATTACHMENT_MAX_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const storageKey = `issues/${randomUUID()}`;
  const mime = file.type || "application/octet-stream";
  const filename = sanitizeFilename(file.name || "file");

  try {
    await putObject(storageKey, bytes, mime);
  } catch (error) {
    console.error("Issue attachment upload to storage failed:", error);
    return NextResponse.json({ error: "storage" }, { status: 502 });
  }

  const [row] = await db
    .insert(issueAttachments)
    .values({
      issueId: id,
      storageKey,
      filename,
      mime,
      sizeBytes: bytes.byteLength,
      uploadedById: session.user.id,
    })
    .returning({ id: issueAttachments.id });

  return NextResponse.json({
    id: row.id,
    filename,
    sizeBytes: bytes.byteLength,
  });
}
