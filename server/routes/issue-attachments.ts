import { randomUUID } from "node:crypto";
import { z } from "zod";
import { routeProjectGuard } from "@/lib/authz";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import { issueAttachments } from "@/lib/db/schema";
import { getObject, putObject } from "@/lib/storage";
import {
  ISSUE_ATTACHMENT_MAX_BYTES,
  issueIdSchema,
  uuidSchema,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  deleteIssueAttachment,
  listIssueAttachments,
} from "@/server/services/issue-attachments";
import { json, query } from "@/server/validation";

export const issueAttachmentsRouter = sessionRouter()
  .get(
    "/list-issue-attachments",
    query(z.object({ issueId: uuidSchema })),
    async (c) =>
      c.json(await listIssueAttachments(c.req.valid("query").issueId))
  )
  .post(
    "/delete-issue-attachment",
    json(z.object({ id: uuidSchema })),
    async (c) => c.json(await deleteIssueAttachment(c.req.valid("json").id))
  );

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
 * The upload and download endpoints ported from app/api/issues/**. They keep
 * their paths (mounted at /api/issues) because rendered issue bodies and the
 * attachment list link to them; responses are byte-for-byte what the Next
 * handlers sent, except that a signed-out caller is stopped by the session
 * router (JSON 401) before any id check.
 */
export const issueAttachmentFilesRouter = sessionRouter()
  /**
   * Upload an attachment to an issue. Through-app so auth is enforced here and
   * the bucket stays private. Any file type is accepted (logs, screenshots,
   * PDFs) up to the size ceiling; bytes are stored as-is and served back as a
   * download. Multipart, so no JSON validator.
   */
  .post("/:id/attachments", async (c) => {
    const id = c.req.param("id");
    if (!issueIdSchema.safeParse(id).success) {
      return c.json({ error: "bad_request" }, 400);
    }

    // The guard resolves the issue's project, so an unknown issue is a 404 and
    // a bad id can't leave an orphaned object in the bucket.
    const guard = await routeProjectGuard(
      { issueId: id },
      { issue: ["write"] }
    );
    if (!guard.ok) return guard.response;
    const { session } = guard;

    const form = await c.req.raw.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "no_file" }, 400);
    }
    if (file.size > ISSUE_ATTACHMENT_MAX_BYTES) {
      return c.json({ error: "too_large" }, 413);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const storageKey = `issues/${randomUUID()}`;
    const mime = file.type || "application/octet-stream";
    const filename = sanitizeFilename(file.name || "file");

    try {
      await putObject(storageKey, bytes, mime);
    } catch (error) {
      console.error("Issue attachment upload to storage failed:", error);
      return c.json({ error: "storage" }, 502);
    }

    const row = one(
      await db
        .insert(issueAttachments)
        .values({
          issueId: id,
          storageKey,
          filename,
          mime,
          sizeBytes: bytes.byteLength,
          uploadedById: session.user.id,
        })
        .returning({ id: issueAttachments.id }),
      "issue attachment"
    );

    return c.json({ id: row.id, filename, sizeBytes: bytes.byteLength });
  })
  /**
   * Serve an issue attachment as a download. The row links here by stable id
   * (never a raw storage URL), so the bucket stays private and every read is
   * session-gated. Bytes are streamed as-is with `Content-Disposition:
   * attachment` so no file type can execute inline in the browser.
   */
  .get("/attachments/:id", async (c) => {
    const id = c.req.param("id");
    if (!issueIdSchema.safeParse(id).success) {
      return new Response("Bad request", { status: 400 });
    }

    const row = await db.query.issueAttachments.findFirst({
      where: { id },
      columns: { storageKey: true, filename: true, mime: true, issueId: true },
    });
    if (!row) return new Response("Not found", { status: 404 });
    const guard = await routeProjectGuard(
      { issueId: row.issueId },
      { project: ["read"] }
    );
    if (!guard.ok) return guard.response;

    let obj: Awaited<ReturnType<typeof getObject>>;
    try {
      obj = await getObject(row.storageKey);
    } catch (error) {
      console.error(`Failed to fetch issue attachment ${id}:`, error);
      return new Response("Storage error", { status: 502 });
    }

    // Both a plain (legacy client) and an RFC 5987 encoded filename so
    // non-ASCII names survive; the sanitizer already stripped quotes/control
    // chars.
    const encoded = encodeURIComponent(row.filename);
    return new Response(obj.body, {
      headers: {
        "Content-Type":
          row.mime || obj.contentType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${row.filename}"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  });
