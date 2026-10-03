"use server";

import { asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-session";
import { requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { issueAttachments } from "@/lib/db/schema";
import { deleteObject } from "@/lib/storage";
import { uuidSchema } from "@/lib/validation";

export type IssueAttachmentRow = {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  createdAt: Date;
};

/** Attachments on an issue, oldest first. Upload happens via the API route. */
export async function listIssueAttachments(
  issueId: string
): Promise<IssueAttachmentRow[]> {
  await requireProjectPermission({ issueId }, { project: ["read"] });
  try {
    return await db
      .select({
        id: issueAttachments.id,
        filename: issueAttachments.filename,
        mime: issueAttachments.mime,
        sizeBytes: issueAttachments.sizeBytes,
        createdAt: issueAttachments.createdAt,
      })
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, issueId))
      .orderBy(asc(issueAttachments.createdAt));
  } catch (error) {
    console.error("Failed to list issue attachments:", error);
    return [];
  }
}

export async function deleteIssueAttachment(
  id: string
): Promise<{ success: boolean; message?: string }> {
  // Signed-in callers only before the lookup, which reveals whether the id
  // exists; a non-uuid id is "not found" rather than a Postgres error.
  await requireSession();
  if (!uuidSchema.safeParse(id).success) {
    return { success: false, message: "Not found" };
  }
  const row = await db.query.issueAttachments.findFirst({
    where: { id },
    columns: { storageKey: true, issueId: true },
  });
  if (!row) return { success: false, message: "Not found" };
  await requireProjectPermission(
    { issueId: row.issueId },
    { issue: ["write"] }
  );
  try {
    // Best-effort object delete — if it fails we still drop the row so the UI
    // doesn't keep showing a broken attachment; the orphan can be swept later.
    await deleteObject(row.storageKey);
  } catch (error) {
    console.error(`Failed to delete attachment object for ${id}:`, error);
  }
  await db.delete(issueAttachments).where(eq(issueAttachments.id, id));
  revalidatePath("/", "layout");
  return { success: true };
}
