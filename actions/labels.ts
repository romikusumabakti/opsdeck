"use server";

import { asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { issueLabels, type Label, labels } from "@/lib/db/schema";

/** All workspace labels, name-ordered — for chips and the label filter/picker. */
export async function listLabels(): Promise<Label[]> {
  await requireSession();
  try {
    return await db.select().from(labels).orderBy(asc(labels.name));
  } catch (error) {
    console.error("Failed to list labels:", error);
    return [];
  }
}

/** Replace an issue's label set with `labelIds` (transactional). */
export async function setIssueLabels(
  issueId: string,
  labelIds: string[]
): Promise<{ success: boolean }> {
  await requireSession();
  try {
    await db.transaction(async (tx) => {
      await tx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
      if (labelIds.length > 0) {
        await tx
          .insert(issueLabels)
          .values(labelIds.map((labelId) => ({ issueId, labelId })));
      }
    });
    revalidatePath("/projects", "layout");
    return { success: true };
  } catch (error) {
    console.error("Failed to set issue labels:", error);
    return { success: false };
  }
}
