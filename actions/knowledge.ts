"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin, requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import {
  type KnowledgeCollection,
  type KnowledgeDocument,
  knowledgeCollections,
  knowledgeDocuments,
  knowledgeLinks,
  knowledgeRevisions,
} from "@/lib/db/schema";
import {
  appendCollectionRank,
  appendDocumentRank,
  type Backlink,
  ensureUniqueSlug,
  extractLinkedSlugs,
  loadBacklinks,
  markdownToPlainText,
  resolveSlugIds,
  type SearchHit,
  searchDocuments,
  slugify,
} from "@/lib/knowledge";
import {
  collectionInputSchema,
  collectionMoveSchema,
  collectionUpdateSchema,
  documentInputSchema,
  documentMoveSchema,
  documentUpdateSchema,
  knowledgeIdSchema,
  knowledgeSearchSchema,
} from "@/lib/validation";

type ActionResponse<T> = {
  success: boolean;
  message?: string;
  data?: T;
};

// The transaction handle passed to db.transaction's callback — same query API
// as `db`, so helpers below take it instead of the top-level connection.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const KNOWLEDGE_PATH = "/knowledge";

// --- Collections (admin-managed) --------------------------------------------

export async function createCollection(
  data: unknown
): Promise<ActionResponse<KnowledgeCollection>> {
  const session = await requireAdmin();
  const parsed = collectionInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid collection data" };
  }
  try {
    const [created] = await db
      .insert(knowledgeCollections)
      .values({
        ...parsed.data,
        rank: await appendCollectionRank(),
        createdById: session.user.id,
      })
      .returning();
    revalidatePath(KNOWLEDGE_PATH);
    return { success: true, data: created };
  } catch (error) {
    console.error("Failed to create collection:", error);
    return { success: false, message: "Failed to create collection" };
  }
}

export async function updateCollection(
  id: string,
  data: unknown
): Promise<ActionResponse<KnowledgeCollection>> {
  await requireAdmin();
  if (!knowledgeIdSchema.safeParse(id).success) {
    return { success: false, message: "Invalid collection id" };
  }
  const parsed = collectionUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid collection data" };
  }
  try {
    const [updated] = await db
      .update(knowledgeCollections)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(knowledgeCollections.id, id))
      .returning();
    if (!updated) return { success: false, message: "Collection not found" };
    revalidatePath(KNOWLEDGE_PATH);
    return { success: true, data: updated };
  } catch (error) {
    console.error(`Failed to update collection ${id}:`, error);
    return { success: false, message: "Failed to update collection" };
  }
}

export async function deleteCollection(
  id: string
): Promise<ActionResponse<never>> {
  await requireAdmin();
  if (!knowledgeIdSchema.safeParse(id).success) {
    return { success: false, message: "Invalid collection id" };
  }
  try {
    // Documents cascade-delete via the FK; their revisions and links cascade in
    // turn. Confirmed destructive — admin-gated and the UI warns first.
    await db
      .delete(knowledgeCollections)
      .where(eq(knowledgeCollections.id, id));
    revalidatePath(KNOWLEDGE_PATH);
    return { success: true };
  } catch (error) {
    console.error(`Failed to delete collection ${id}:`, error);
    return { success: false, message: "Failed to delete collection" };
  }
}

// Reorder a collection among its siblings. The client computes the new
// fractional-index rank between the drop neighbours, so this only writes the
// one row — no neighbour is renumbered.
export async function moveCollection(
  data: unknown
): Promise<ActionResponse<never>> {
  await requireAdmin();
  const parsed = collectionMoveSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid move data" };
  }
  const { collectionId, rank } = parsed.data;
  try {
    await db
      .update(knowledgeCollections)
      .set({ rank, updatedAt: new Date() })
      .where(eq(knowledgeCollections.id, collectionId));
    revalidatePath(KNOWLEDGE_PATH);
    return { success: true };
  } catch (error) {
    console.error(`Failed to move collection ${collectionId}:`, error);
    return { success: false, message: "Failed to move collection" };
  }
}

// --- Documents (member-editable) --------------------------------------------

/**
 * Rebuild the backlink edges for `documentId` from its markdown body. Runs
 * inside the caller's transaction: clears this doc's outbound edges, then
 * inserts one per resolvable internal link (self-links skipped).
 */
async function rebuildLinks(
  tx: Tx,
  documentId: string,
  content: string
): Promise<void> {
  await tx
    .delete(knowledgeLinks)
    .where(eq(knowledgeLinks.fromDocumentId, documentId));
  const slugs = extractLinkedSlugs(content);
  if (slugs.length === 0) return;
  const idsBySlug = await resolveSlugIds(slugs);
  const edges = [...idsBySlug.values()]
    .filter((toId) => toId !== documentId)
    .map((toId) => ({ fromDocumentId: documentId, toDocumentId: toId }));
  if (edges.length > 0) {
    await tx.insert(knowledgeLinks).values(edges).onConflictDoNothing();
  }
}

export async function createDocument(
  data: unknown
): Promise<ActionResponse<KnowledgeDocument>> {
  const session = await requireSession();
  const parsed = documentInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid document data" };
  }
  const { collectionId, parentId, title, content, projectId, publishedAt } =
    parsed.data;
  try {
    const slug = await ensureUniqueSlug(slugify(title));
    const rank = await appendDocumentRank(collectionId, parentId ?? null);
    const created = await db.transaction(async (tx) => {
      const [doc] = await tx
        .insert(knowledgeDocuments)
        .values({
          collectionId,
          parentId: parentId ?? null,
          title,
          slug,
          content,
          contentText: markdownToPlainText(content),
          rank,
          projectId: projectId ?? null,
          publishedAt: publishedAt ? new Date(publishedAt) : null,
          createdById: session.user.id,
          updatedById: session.user.id,
        })
        .returning();
      await rebuildLinks(tx, doc.id, content);
      return doc;
    });
    revalidatePath(KNOWLEDGE_PATH);
    return { success: true, data: created };
  } catch (error) {
    console.error("Failed to create document:", error);
    return { success: false, message: "Failed to create document" };
  }
}

export async function updateDocument(
  id: string,
  data: unknown
): Promise<ActionResponse<KnowledgeDocument>> {
  const session = await requireSession();
  if (!knowledgeIdSchema.safeParse(id).success) {
    return { success: false, message: "Invalid document id" };
  }
  const parsed = documentUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid document data" };
  }
  const input = parsed.data;
  try {
    const result = await db.transaction(async (tx) => {
      const existing = await tx.query.knowledgeDocuments.findFirst({
        where: { id },
      });
      if (!existing) return { kind: "notfound" } as const;

      const nextTitle = input.title ?? existing.title;
      const nextContent = input.content ?? existing.content;
      const nextCollectionId = input.collectionId ?? existing.collectionId;

      // Re-slug only when the title changed; keep stable URLs otherwise.
      const slug =
        input.title && input.title !== existing.title
          ? await ensureUniqueSlug(slugify(nextTitle), id)
          : existing.slug;

      const set: Partial<typeof knowledgeDocuments.$inferInsert> = {
        title: nextTitle,
        slug,
        content: nextContent,
        contentText: markdownToPlainText(nextContent),
        collectionId: nextCollectionId,
        version: existing.version + 1,
        updatedById: session.user.id,
        updatedAt: new Date(),
      };
      if (input.parentId !== undefined) set.parentId = input.parentId ?? null;
      if (input.projectId !== undefined)
        set.projectId = input.projectId ?? null;
      if (input.publishedAt !== undefined)
        set.publishedAt = input.publishedAt
          ? new Date(input.publishedAt)
          : null;

      // Optimistic concurrency: when the editor sent the version it loaded,
      // guard the write on it. A version mismatch matches zero rows — the doc
      // moved under us — so we bail BEFORE writing the revision snapshot,
      // leaving the transaction a no-op rather than overwriting a newer edit.
      const guard =
        input.expectedVersion !== undefined
          ? and(
              eq(knowledgeDocuments.id, id),
              eq(knowledgeDocuments.version, input.expectedVersion)
            )
          : eq(knowledgeDocuments.id, id);

      const [doc] = await tx
        .update(knowledgeDocuments)
        .set(set)
        .where(guard)
        .returning();
      if (!doc) return { kind: "stale" } as const;

      // Snapshot the PRIOR state now that the write succeeded so history is
      // complete and a restore is possible.
      await tx.insert(knowledgeRevisions).values({
        documentId: id,
        title: existing.title,
        content: existing.content,
        editedById: session.user.id,
      });

      if (input.content !== undefined) {
        await rebuildLinks(tx, id, nextContent);
      }
      return { kind: "ok", doc } as const;
    });

    if (result.kind === "notfound") {
      return { success: false, message: "Document not found" };
    }
    if (result.kind === "stale") {
      return {
        success: false,
        message: "Document changed since you opened it — reload and retry",
      };
    }
    revalidatePath(KNOWLEDGE_PATH);
    revalidatePath(`${KNOWLEDGE_PATH}/${result.doc.slug}`);
    return { success: true, data: result.doc };
  } catch (error) {
    console.error(`Failed to update document ${id}:`, error);
    return { success: false, message: "Failed to update document" };
  }
}

export async function moveDocument(
  data: unknown
): Promise<ActionResponse<never>> {
  await requireSession();
  const parsed = documentMoveSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid move data" };
  }
  const { documentId, collectionId, parentId, rank } = parsed.data;
  try {
    await db.transaction(async (tx) => {
      // Guard against cycles INSIDE the tx so the ancestor walk and the write
      // see one consistent snapshot — a concurrent move can't slip a cycle
      // through the gap between check and update.
      if (parentId && (await isDescendant(tx, parentId, documentId))) {
        throw new MoveCycleError();
      }
      await tx
        .update(knowledgeDocuments)
        .set({
          parentId: parentId ?? null,
          rank,
          collectionId,
          // Bump the optimistic-concurrency token so a move is observable to an
          // editor holding a stale version, consistent with updateDocument.
          version: sql`${knowledgeDocuments.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeDocuments.id, documentId));

      // The moved node may carry a subtree. Re-home every descendant into the
      // same destination collection so root grouping stays consistent.
      const descendants = await collectDescendants(tx, documentId);
      if (descendants.length > 0) {
        await tx
          .update(knowledgeDocuments)
          .set({ collectionId })
          .where(inArray(knowledgeDocuments.id, descendants));
      }
    });
    revalidatePath(KNOWLEDGE_PATH);
    return { success: true };
  } catch (error) {
    if (error instanceof MoveCycleError) {
      return { success: false, message: "Cannot nest a document under itself" };
    }
    console.error(`Failed to move document ${documentId}:`, error);
    return { success: false, message: "Failed to move document" };
  }
}

// Thrown inside moveDocument's transaction when the requested parent sits below
// the moved node — surfaces as a user-facing message, not a 500, while still
// rolling the transaction back.
class MoveCycleError extends Error {}

// Breadth-first collect of every descendant id under `rootId` (exclusive).
// Bounded by a node cap so a corrupt cycle can't loop forever.
async function collectDescendants(tx: Tx, rootId: string): Promise<string[]> {
  const seen = new Set<string>();
  let frontier = [rootId];
  for (let i = 0; i < 10_000 && frontier.length > 0; ) {
    const children = await tx
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(inArray(knowledgeDocuments.parentId, frontier));
    frontier = children.map((c) => c.id).filter((id) => !seen.has(id));
    for (const id of frontier) seen.add(id);
    i += frontier.length;
  }
  return [...seen];
}

// Walk up from `nodeId` to see whether `ancestorId` sits above it — prevents a
// move that would create a parent/child cycle. Runs on the caller's tx so the
// walk and the subsequent write share one snapshot. Bounded by a depth cap so a
// pre-existing corrupt cycle can't spin forever.
async function isDescendant(
  tx: Tx,
  nodeId: string,
  ancestorId: string
): Promise<boolean> {
  let current: string | null = nodeId;
  for (let depth = 0; current && depth < 1000; depth++) {
    if (current === ancestorId) return true;
    const [row]: { parentId: string | null }[] = await tx
      .select({ parentId: knowledgeDocuments.parentId })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, current))
      .limit(1);
    current = row?.parentId ?? null;
  }
  return false;
}

export async function deleteDocument(
  id: string
): Promise<ActionResponse<never>> {
  // Deleting is admin-only; members reach a deleted-doc URL → handled by the
  // route's notFound(). Children re-parent to the collection root via the FK's
  // set-null, so a delete never silently removes a subtree.
  await requireAdmin();
  if (!knowledgeIdSchema.safeParse(id).success) {
    return { success: false, message: "Invalid document id" };
  }
  try {
    await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, id));
    revalidatePath(KNOWLEDGE_PATH);
    return { success: true };
  } catch (error) {
    console.error(`Failed to delete document ${id}:`, error);
    return { success: false, message: "Failed to delete document" };
  }
}

/** Restore a document to a prior revision (snapshots current state first). */
export async function restoreRevision(
  documentId: string,
  revisionId: string
): Promise<ActionResponse<KnowledgeDocument>> {
  const session = await requireSession();
  if (
    !knowledgeIdSchema.safeParse(documentId).success ||
    !knowledgeIdSchema.safeParse(revisionId).success
  ) {
    return { success: false, message: "Invalid id" };
  }
  try {
    const restored = await db.transaction(async (tx) => {
      const rev = await tx.query.knowledgeRevisions.findFirst({
        where: { id: revisionId, documentId },
      });
      const existing = await tx.query.knowledgeDocuments.findFirst({
        where: { id: documentId },
      });
      if (!rev || !existing) return null;

      // Snapshot current before restoring so the restore is itself reversible.
      await tx.insert(knowledgeRevisions).values({
        documentId,
        title: existing.title,
        content: existing.content,
        editedById: session.user.id,
      });

      const [doc] = await tx
        .update(knowledgeDocuments)
        .set({
          title: rev.title,
          content: rev.content,
          contentText: markdownToPlainText(rev.content),
          version: existing.version + 1,
          updatedById: session.user.id,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeDocuments.id, documentId))
        .returning();
      await rebuildLinks(tx, documentId, rev.content);
      return doc;
    });
    if (!restored) return { success: false, message: "Revision not found" };
    revalidatePath(`${KNOWLEDGE_PATH}/${restored.slug}`);
    return { success: true, data: restored };
  } catch (error) {
    console.error(`Failed to restore revision ${revisionId}:`, error);
    return { success: false, message: "Failed to restore revision" };
  }
}

// --- Read actions (client-callable) -----------------------------------------

export async function searchKnowledge(query: string): Promise<SearchHit[]> {
  await requireSession();
  const parsed = knowledgeSearchSchema.safeParse(query);
  if (!parsed.success) return [];
  try {
    return await searchDocuments(parsed.data);
  } catch (error) {
    console.error("Knowledge search failed:", error);
    return [];
  }
}

export async function getBacklinks(documentId: string): Promise<Backlink[]> {
  await requireSession();
  if (!knowledgeIdSchema.safeParse(documentId).success) return [];
  try {
    return await loadBacklinks(documentId);
  } catch (error) {
    console.error("Failed to load backlinks:", error);
    return [];
  }
}
