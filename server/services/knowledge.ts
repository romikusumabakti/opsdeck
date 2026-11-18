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
  knowledgeSlugSchema,
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

// A document's subpages live in its collection: create, update and move refuse
// a parent from another collection, and a collection change carries the
// subtree that shares the document's collection. Rows from before this rule
// may still hold a child in another collection than its parent; writes stop
// at that boundary and never touch it.
const PARENT_IN_OTHER_COLLECTION =
  "The parent document is in another collection";

const INVALID_SLUG = "Invalid document slug";

/** The requested slug when valid, `undefined` when none, `null` when invalid. */
function requestedSlug(slug: string | undefined): string | undefined | null {
  if (slug === undefined) return undefined;
  const parsed = knowledgeSlugSchema.safeParse(slug);
  return parsed.success ? parsed.data : null;
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

/**
 * Edges into a document just created at `slug` from the documents that
 * already link to that slug: a link written before its target existed (a
 * placeholder in the editor, a later file of the same import) resolves once
 * the target is there, without re-saving the linking document. Stored whole
 * and gated on read, like rebuildLinks.
 */
async function linkInbound(
  tx: Tx,
  documentId: string,
  slug: string
): Promise<void> {
  // Slugs are [a-z0-9-] (knowledgeSlugSchema), so no LIKE wildcard to escape;
  // extractLinkedSlugs then drops matches inside code or of a longer slug.
  const candidates = await tx
    .select({ id: knowledgeDocuments.id, content: knowledgeDocuments.content })
    .from(knowledgeDocuments)
    .where(
      and(
        sql`${knowledgeDocuments.id} <> ${documentId}`,
        sql`${knowledgeDocuments.content} like ${`%/knowledge/${slug})%`}`
      )
    );
  const edges = candidates
    .filter((c) => extractLinkedSlugs(c.content).includes(slug))
    .map((c) => ({ fromDocumentId: c.id, toDocumentId: documentId }));
  if (edges.length > 0) {
    await tx.insert(knowledgeLinks).values(edges).onConflictDoNothing();
  }
}

export async function createDocument(
  data: unknown
): Promise<ActionResponse<KnowledgeDocument>> {
  return createDocumentFor(await sessionActor(), data);
}

/**
 * Server-side options of the document cores, never read from a request body:
 * `slug` asks for that slug instead of the title's (the knowledge import's
 * front matter). It goes through the same uniqueness rule, so it may come back
 * suffixed.
 */
export type DocumentWriteOptions = { slug?: string };

// The slug is unique across every document, hidden ones included, so a title
// that collides with a document the actor cannot see is suffixed like any
// other collision — never refused with a conflict that would name it.
export async function createDocumentFor(
  actor: KnowledgeActor,
  data: unknown,
  options: DocumentWriteOptions = {}
): Promise<ActionResponse<KnowledgeDocument>> {
  requireOrgPermissionIn({ orgRole: actor.role }, { knowledge: ["write"] });
  const parsed = documentInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid document data" };
  }
  const wantedSlug = requestedSlug(options.slug);
  if (wantedSlug === null) return { success: false, message: INVALID_SLUG };
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
    // A collection or parent the actor may not see reads as missing; a
    // visible parent must sit in the same collection.
    const parent = parentId
      ? await findVisibleDoc(db, viewer, parentId)
      : undefined;
    const visible =
      (await collectionVisible(db, viewer, collectionId)) &&
      (!parentId || parent !== undefined);
    if (visible && parent && parent.collectionId !== collectionId) {
      return { success: false, message: PARENT_IN_OTHER_COLLECTION };
    }
    if (visible) {
      const slug = await ensureUniqueSlug(wantedSlug ?? slugify(title));
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
        await linkInbound(tx, doc.id, doc.slug);
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
  data: unknown,
  options: DocumentWriteOptions = {}
): Promise<ActionResponse<KnowledgeDocument>> {
  requireOrgPermissionIn({ orgRole: actor.role }, { knowledge: ["write"] });
  if (!knowledgeIdSchema.safeParse(id).success) {
    return { success: false, message: "Invalid document id" };
  }
  const parsed = documentUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid document data" };
  }
  const wantedSlug = requestedSlug(options.slug);
  if (wantedSlug === null) return { success: false, message: INVALID_SLUG };
  const input = parsed.data;
  const viewer = viewerOf(actor);
  let result:
    | { kind: "notfound" }
    | { kind: "stale" }
    | { kind: "foreignParent" }
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
      const nextCollectionId = input.collectionId ?? existing.collectionId;
      const collectionChanged = nextCollectionId !== existing.collectionId;
      // A new parent must be visible and in the document's (next) collection.
      // The current parent is kept while the collection stays; when the
      // document leaves it for another collection, the document moves to that
      // collection's root.
      let nextParentId = existing.parentId;
      if (
        input.parentId !== undefined &&
        input.parentId !== existing.parentId
      ) {
        if (input.parentId) {
          const parent = await findVisibleDoc(tx, viewer, input.parentId);
          if (!parent) return { kind: "notfound" } as const;
          if (parent.collectionId !== nextCollectionId) {
            return { kind: "foreignParent" } as const;
          }
        }
        nextParentId = input.parentId ?? null;
      } else if (existing.parentId && collectionChanged) {
        const [parent] = await tx
          .select({ collectionId: knowledgeDocuments.collectionId })
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.id, existing.parentId))
          .limit(1);
        if (parent?.collectionId !== nextCollectionId) nextParentId = null;
      }

      const nextTitle = input.title ?? existing.title;
      const nextContent = input.content ?? existing.content;

      // Re-slug only when the title changed; keep stable URLs otherwise. An
      // explicit slug (options) wins over the title's.
      const slug =
        wantedSlug !== undefined
          ? await ensureUniqueSlug(wantedSlug, id)
          : input.title && input.title !== existing.title
            ? await ensureUniqueSlug(slugify(nextTitle), id)
            : existing.slug;

      const set: Partial<typeof knowledgeDocuments.$inferInsert> = {
        title: nextTitle,
        slug,
        content: nextContent,
        contentText: markdownToPlainText(nextContent),
        collectionId: nextCollectionId,
        parentId: nextParentId,
        version: existing.version + 1,
        updatedById: actor.userId,
        updatedAt: new Date(),
      };
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

      if (collectionChanged) {
        await carrySubtree(tx, id, existing.collectionId, nextCollectionId);
      }

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
  if (result.kind === "foreignParent") {
    return { success: false, message: PARENT_IN_OTHER_COLLECTION };
  }
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
  let outcome: "ok" | "notfound" | "foreignParent";
  try {
    outcome = await db.transaction(async (tx) => {
      // The moved document, its destination collection and a new parent are
      // all resolved as the actor sees them: a hidden one reads as missing.
      // The current parent is read as stored (a reorder under it stays
      // possible); either must sit in the destination collection.
      const existing = await findVisibleDoc(tx, viewer, documentId);
      if (!existing || !(await collectionVisible(tx, viewer, collectionId))) {
        return "notfound";
      }
      if (parentId) {
        const [parent] =
          parentId === existing.parentId
            ? await tx
                .select({ collectionId: knowledgeDocuments.collectionId })
                .from(knowledgeDocuments)
                .where(eq(knowledgeDocuments.id, parentId))
                .limit(1)
            : [await findVisibleDoc(tx, viewer, parentId)];
        if (!parent) return "notfound";
        if (parent.collectionId !== collectionId) {
          // Only a parent the actor sees is named in the refusal.
          return (await findVisibleDoc(tx, viewer, parentId))
            ? "foreignParent"
            : "notfound";
        }
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

      if (collectionId !== existing.collectionId) {
        await carrySubtree(tx, documentId, existing.collectionId, collectionId);
      }
      return "ok";
    });
  } catch (error) {
    if (error instanceof MoveCycleError) {
      return { success: false, message: "Cannot nest a document under itself" };
    }
    console.error(`Failed to move document ${documentId}:`, error);
    return { success: false, message: "Failed to move document" };
  }
  if (outcome === "notfound") notFound();
  if (outcome === "foreignParent") {
    return { success: false, message: PARENT_IN_OTHER_COLLECTION };
  }
  return { success: true };
}

// Thrown inside moveDocument's transaction when the requested parent sits below
// the moved node — surfaces as a user-facing message, not a 500, while still
// rolling the transaction back.
class MoveCycleError extends Error {}

/**
 * Moves the subtree under `rootId` (exclusive) from collection `from` to `to`
 * along with its root. Only descendants in `from` are carried, and the walk
 * stops at a child in any other collection: a child left there by rows from
 * before the same-collection rule (possibly one the actor cannot see) is
 * neither moved nor descended into.
 */
async function carrySubtree(
  tx: Tx,
  rootId: string,
  from: string,
  to: string
): Promise<void> {
  const descendants = await collectDescendants(tx, rootId, from);
  if (descendants.length > 0) {
    await tx
      .update(knowledgeDocuments)
      .set({ collectionId: to })
      .where(inArray(knowledgeDocuments.id, descendants));
  }
}

// Breadth-first collect of every descendant id under `rootId` (exclusive)
// that sits in `collectionId`, through such descendants only. Bounded by a
// node cap so a corrupt cycle can't loop forever.
async function collectDescendants(
  tx: Tx,
  rootId: string,
  collectionId: string
): Promise<string[]> {
  const seen = new Set<string>();
  let frontier = [rootId];
  for (let i = 0; i < 10_000 && frontier.length > 0; ) {
    const children = await tx
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(
        and(
          inArray(knowledgeDocuments.parentId, frontier),
          eq(knowledgeDocuments.collectionId, collectionId)
        )
      );
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
