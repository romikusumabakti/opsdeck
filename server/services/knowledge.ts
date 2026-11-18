import { and, eq, inArray, sql } from "drizzle-orm";
import { requireOrgPermissionIn } from "@/lib/access-scope";
import { requireSession } from "@/lib/auth-session";
import { requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
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
  type KnowledgeViewer,
  loadBacklinks,
  markdownToPlainText,
  parseVisibleToRoles,
  type SearchHit,
  searchDocuments,
  slugify,
  visibleCollections,
  visibleDocs,
} from "@/lib/knowledge";
import { canOrg, normalizeOrgRole, type OrgRole } from "@/lib/permissions";
import type { ActionResponse } from "@/lib/types";
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
import { badRequest, notFound } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

// The transaction handle passed to db.transaction's callback — same query API
// as `db`, so helpers below take it instead of the top-level connection.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// --- Actor ------------------------------------------------------------------

/**
 * Who writes. The write services are session wrappers around `*For(actor, …)`
 * cores, so callers with no request session (the knowledge import CLI) go
 * through the same rules: the core checks the actor's org permission, then
 * resolves every target collection, document, parent and revision through
 * the reader's visibility rule (lib/knowledge#visibleDocs). A target the actor
 * may not see answers 404 exactly like a missing one.
 */
export type KnowledgeActor = { userId: string; role: OrgRole };

async function sessionActor(): Promise<KnowledgeActor> {
  const session = await requireSession();
  return { userId: session.user.id, role: normalizeOrgRole(session.user.role) };
}

function viewerOf(actor: KnowledgeActor): KnowledgeViewer {
  return {
    userId: actor.userId,
    role: actor.role,
    canManage: canOrg(actor.role, { knowledge: ["manage"] }),
  };
}

/** Whether collection `id` exists and `viewer` may see it. */
async function collectionVisible(
  q: Tx | typeof db,
  viewer: KnowledgeViewer,
  id: string
): Promise<boolean> {
  const [row] = await q
    .select({ id: knowledgeCollections.id })
    .from(knowledgeCollections)
    .where(and(eq(knowledgeCollections.id, id), visibleCollections(viewer)))
    .limit(1);
  return row !== undefined;
}

/** Document `id` when it exists and `viewer` may see it. */
async function findVisibleDoc(
  q: Tx | typeof db,
  viewer: KnowledgeViewer,
  id: string
): Promise<KnowledgeDocument | undefined> {
  const [row] = await q
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, id), visibleDocs(viewer)))
    .limit(1);
  return row;
}

/**
 * A requested visibility list as stored (parseVisibleToRoles), or a 400 with
 * a stable code. Thrown outside the cores' try blocks so it reaches the API.
 */
async function checkedVisibleToRoles(roles: string[]): Promise<OrgRole[]> {
  const parsed = parseVisibleToRoles(roles);
  if (parsed) return parsed;
  const t = await getServerTranslator("actionErrors");
  badRequest(t("knowledgeVisibilityInvalid"), "knowledgeVisibilityInvalid");
}

// --- Collections (admin-managed) --------------------------------------------

export async function createCollection(
  data: unknown
): Promise<ActionResponse<KnowledgeCollection>> {
  return createCollectionFor(await sessionActor(), data);
}

export async function createCollectionFor(
  actor: KnowledgeActor,
  data: unknown
): Promise<ActionResponse<KnowledgeCollection>> {
  requireOrgPermissionIn({ orgRole: actor.role }, { knowledge: ["manage"] });
  const parsed = collectionInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid collection data" };
  }
  const { visibleToRoles, ...fields } = parsed.data;
  const roles = await checkedVisibleToRoles(visibleToRoles ?? []);
  try {
    const created = one(
      await db
        .insert(knowledgeCollections)
        .values({
          ...fields,
          visibleToRoles: roles,
          rank: await appendCollectionRank(),
          createdById: actor.userId,
        })
        .returning(),
      "knowledge collection"
    );
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
  return updateCollectionFor(await sessionActor(), id, data);
}

// A manager sees every collection, so the lookup needs no visibility rule.
// A changed list applies at once to every document in the collection.
export async function updateCollectionFor(
  actor: KnowledgeActor,
  id: string,
  data: unknown
): Promise<ActionResponse<KnowledgeCollection>> {
  requireOrgPermissionIn({ orgRole: actor.role }, { knowledge: ["manage"] });
  if (!knowledgeIdSchema.safeParse(id).success) {
    return { success: false, message: "Invalid collection id" };
  }
  const parsed = collectionUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid collection data" };
  }
  const { visibleToRoles, ...fields } = parsed.data;
  const set: Partial<typeof knowledgeCollections.$inferInsert> = {
    ...fields,
    updatedAt: new Date(),
  };
  if (visibleToRoles !== undefined) {
    set.visibleToRoles = await checkedVisibleToRoles(visibleToRoles);
  }
  try {
    const [updated] = await db
      .update(knowledgeCollections)
      .set(set)
      .where(eq(knowledgeCollections.id, id))
      .returning();
    if (!updated) return { success: false, message: "Collection not found" };
    return { success: true, data: updated };
  } catch (error) {
    console.error(`Failed to update collection ${id}:`, error);
    return { success: false, message: "Failed to update collection" };
  }
}

export async function deleteCollection(
  id: string
): Promise<ActionResponse<never>> {
  await requireOrgPermission({ knowledge: ["manage"] });
  if (!knowledgeIdSchema.safeParse(id).success) {
    return { success: false, message: "Invalid collection id" };
  }
  try {
    // Documents cascade-delete via the FK; their revisions and links cascade in
    // turn. Confirmed destructive — admin-gated and the UI warns first.
    await db
      .delete(knowledgeCollections)
      .where(eq(knowledgeCollections.id, id));
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
  await requireOrgPermission({ knowledge: ["manage"] });
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
  // Every existing target, whoever saves: the graph is stored whole and gated
  // on read (loadBacklinks filters both ends by the reader), so an edge to a
  // collection the writer cannot see is kept for those who can, and stays
  // right when a collection's visibility changes. Nothing here reaches the
  // writer's response.
  const targets = await tx
    .select({ id: knowledgeDocuments.id })
    .from(knowledgeDocuments)
    .where(inArray(knowledgeDocuments.slug, slugs));
  const edges = targets
    .map((t) => t.id)
    .filter((toId) => toId !== documentId)
    .map((toId) => ({ fromDocumentId: documentId, toDocumentId: toId }));
  if (edges.length > 0) {
    await tx.insert(knowledgeLinks).values(edges).onConflictDoNothing();
  }
}

export async function createDocument(
  data: unknown
): Promise<ActionResponse<KnowledgeDocument>> {
  return createDocumentFor(await sessionActor(), data);
}

// The slug is unique across every document, hidden ones included, so a title
// that collides with a document the actor cannot see is suffixed like any
// other collision — never refused with a conflict that would name it.
export async function createDocumentFor(
  actor: KnowledgeActor,
  data: unknown
): Promise<ActionResponse<KnowledgeDocument>> {
  requireOrgPermissionIn({ orgRole: actor.role }, { knowledge: ["write"] });
  const parsed = documentInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid document data" };
  }
  const {
    collectionId,
    parentId,
    title,
    docType,
    content,
    projectId,
    publishedAt,
  } = parsed.data;
  const viewer = viewerOf(actor);
  let created: KnowledgeDocument | null = null;
  try {
    // A collection or parent the actor may not see reads as missing.
    const visible =
      (await collectionVisible(db, viewer, collectionId)) &&
      (!parentId || (await findVisibleDoc(db, viewer, parentId)) !== undefined);
    if (visible) {
      const slug = await ensureUniqueSlug(slugify(title));
      const rank = await appendDocumentRank(collectionId, parentId ?? null);
      created = await db.transaction(async (tx) => {
        const doc = one(
          await tx
            .insert(knowledgeDocuments)
            .values({
              collectionId,
              parentId: parentId ?? null,
              title,
              docType,
              slug,
              content,
              contentText: markdownToPlainText(content),
              rank,
              projectId: projectId ?? null,
              publishedAt: publishedAt ? new Date(publishedAt) : null,
              createdById: actor.userId,
              updatedById: actor.userId,
            })
            .returning(),
          "knowledge document"
        );
        await rebuildLinks(tx, doc.id, content);
        return doc;
      });
    }
  } catch (error) {
    console.error("Failed to create document:", error);
    return { success: false, message: "Failed to create document" };
  }
  if (!created) notFound();
  return { success: true, data: created };
}

export async function updateDocument(
  id: string,
  data: unknown
): Promise<ActionResponse<KnowledgeDocument>> {
  return updateDocumentFor(await sessionActor(), id, data);
}

export async function updateDocumentFor(
  actor: KnowledgeActor,
  id: string,
  data: unknown
): Promise<ActionResponse<KnowledgeDocument>> {
  requireOrgPermissionIn({ orgRole: actor.role }, { knowledge: ["write"] });
  if (!knowledgeIdSchema.safeParse(id).success) {
    return { success: false, message: "Invalid document id" };
  }
  const parsed = documentUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid document data" };
  }
  const input = parsed.data;
  const viewer = viewerOf(actor);
  let result:
    | { kind: "notfound" }
    | { kind: "stale" }
    | { kind: "ok"; doc: KnowledgeDocument };
  try {
    result = await db.transaction(async (tx) => {
      // Hidden (another role's collection, someone else's draft) reads as
      // missing, and so does a destination collection or parent the actor
      // cannot see. Checked only when they change: an unchanged one is the
      // document's own, already resolved above.
      const existing = await findVisibleDoc(tx, viewer, id);
      if (!existing) return { kind: "notfound" } as const;
      if (
        input.collectionId !== undefined &&
        input.collectionId !== existing.collectionId &&
        !(await collectionVisible(tx, viewer, input.collectionId))
      ) {
        return { kind: "notfound" } as const;
      }
      if (
        input.parentId &&
        input.parentId !== existing.parentId &&
        !(await findVisibleDoc(tx, viewer, input.parentId))
      ) {
        return { kind: "notfound" } as const;
      }

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
        updatedById: actor.userId,
        updatedAt: new Date(),
      };
      if (input.parentId !== undefined) set.parentId = input.parentId ?? null;
      if (input.docType !== undefined) set.docType = input.docType;
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

      const doc = one(
        await tx.update(knowledgeDocuments).set(set).where(guard).returning(),
        "knowledge document"
      );
      if (!doc) return { kind: "stale" } as const;

      // Snapshot the PRIOR state now that the write succeeded so history is
      // complete and a restore is possible.
      await tx.insert(knowledgeRevisions).values({
        documentId: id,
        title: existing.title,
        content: existing.content,
        editedById: actor.userId,
      });

      if (input.content !== undefined) {
        await rebuildLinks(tx, id, nextContent);
      }
      return { kind: "ok", doc } as const;
    });
  } catch (error) {
    console.error(`Failed to update document ${id}:`, error);
    return { success: false, message: "Failed to update document" };
  }

  if (result.kind === "notfound") notFound();
  if (result.kind === "stale") {
    return {
      success: false,
      message: "Document changed since you opened it — reload and retry",
    };
  }
  return { success: true, data: result.doc };
}

export async function moveDocument(
  data: unknown
): Promise<ActionResponse<never>> {
  return moveDocumentFor(await sessionActor(), data);
}

export async function moveDocumentFor(
  actor: KnowledgeActor,
  data: unknown
): Promise<ActionResponse<never>> {
  requireOrgPermissionIn({ orgRole: actor.role }, { knowledge: ["write"] });
  const parsed = documentMoveSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid move data" };
  }
  const { documentId, collectionId, parentId, rank } = parsed.data;
  const viewer = viewerOf(actor);
  let found: boolean;
  try {
    found = await db.transaction(async (tx) => {
      // The moved document, its destination collection and a new parent are
      // all resolved as the actor sees them: a hidden one reads as missing.
      const existing = await findVisibleDoc(tx, viewer, documentId);
      if (!existing || !(await collectionVisible(tx, viewer, collectionId))) {
        return false;
      }
      if (
        parentId &&
        parentId !== existing.parentId &&
        !(await findVisibleDoc(tx, viewer, parentId))
      ) {
        return false;
      }
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
      return true;
    });
  } catch (error) {
    if (error instanceof MoveCycleError) {
      return { success: false, message: "Cannot nest a document under itself" };
    }
    console.error(`Failed to move document ${documentId}:`, error);
    return { success: false, message: "Failed to move document" };
  }
  if (!found) notFound();
  return { success: true };
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
  return deleteDocumentFor(await sessionActor(), id);
}

// Deleting is admin-only (a manager sees every document); members reach a
// deleted-doc URL → handled by the route's notFound(). Children re-parent to
// the collection root via the FK's set-null, so a delete never silently
// removes a subtree.
export async function deleteDocumentFor(
  actor: KnowledgeActor,
  id: string
): Promise<ActionResponse<never>> {
  requireOrgPermissionIn({ orgRole: actor.role }, { knowledge: ["manage"] });
  if (!knowledgeIdSchema.safeParse(id).success) {
    return { success: false, message: "Invalid document id" };
  }
  try {
    await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, id));
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
  return restoreRevisionFor(await sessionActor(), documentId, revisionId);
}

// A missing revision, a missing document and one the actor may not see all
// answer the same 404.
export async function restoreRevisionFor(
  actor: KnowledgeActor,
  documentId: string,
  revisionId: string
): Promise<ActionResponse<KnowledgeDocument>> {
  requireOrgPermissionIn({ orgRole: actor.role }, { knowledge: ["write"] });
  if (
    !knowledgeIdSchema.safeParse(documentId).success ||
    !knowledgeIdSchema.safeParse(revisionId).success
  ) {
    return { success: false, message: "Invalid id" };
  }
  const viewer = viewerOf(actor);
  let restored: KnowledgeDocument | null;
  try {
    restored = await db.transaction(async (tx) => {
      const existing = await findVisibleDoc(tx, viewer, documentId);
      if (!existing) return null;
      const rev = await tx.query.knowledgeRevisions.findFirst({
        where: { id: revisionId, documentId },
      });
      if (!rev) return null;

      // Snapshot current before restoring so the restore is itself reversible.
      await tx.insert(knowledgeRevisions).values({
        documentId,
        title: existing.title,
        content: existing.content,
        editedById: actor.userId,
      });

      const doc = one(
        await tx
          .update(knowledgeDocuments)
          .set({
            title: rev.title,
            content: rev.content,
            contentText: markdownToPlainText(rev.content),
            version: existing.version + 1,
            updatedById: actor.userId,
            updatedAt: new Date(),
          })
          .where(eq(knowledgeDocuments.id, documentId))
          .returning(),
        "knowledge document"
      );
      await rebuildLinks(tx, documentId, rev.content);
      return doc;
    });
  } catch (error) {
    console.error(`Failed to restore revision ${revisionId}:`, error);
    return { success: false, message: "Failed to restore revision" };
  }
  if (!restored) notFound();
  return { success: true, data: restored };
}

// --- Read actions (client-callable) -----------------------------------------

export async function searchKnowledge(query: string): Promise<SearchHit[]> {
  await requireOrgPermission({ knowledge: ["read"] });
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
  await requireOrgPermission({ knowledge: ["read"] });
  if (!knowledgeIdSchema.safeParse(documentId).success) return [];
  try {
    return await loadBacklinks(documentId);
  } catch (error) {
    console.error("Failed to load backlinks:", error);
    return [];
  }
}
