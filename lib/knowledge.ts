import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { getServerSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import {
  type KnowledgeCollection,
  type KnowledgeDocumentWithMeta,
  type KnowledgeRevision,
  type KnowledgeTreeNode,
  knowledgeCollections,
  knowledgeDocuments,
  knowledgeLinks,
} from "@/lib/db/schema";
import { canOrg, normalizeOrgRole, type OrgRole } from "@/lib/permissions";

// --- Visibility -------------------------------------------------------------

/**
 * Who is asking. Two rules, both enforced in the DATA layer (here) — not the
 * UI — so no caller can forget to gate:
 *
 * 1. Collections: a collection with an empty `visibleToRoles` is visible to
 *    every role holding knowledge:read; otherwise only to the listed roles.
 *    Unknown stored roles grant nothing.
 * 2. Drafts (publishedAt IS NULL): visible only to their author.
 *
 * knowledge:manage (`canManage`) bypasses both. Collection visibility wins
 * over every other grant: authorship, drafts and a document's projectId never
 * open a collection the viewer's role cannot see. Hidden rows answer exactly
 * like missing ones (null / absent), so nothing about them leaks.
 */
export type KnowledgeViewer = {
  userId: string | null;
  role: OrgRole | null;
  canManage: boolean;
};

/** Resolve the current request's viewer from the session. */
export async function currentViewer(): Promise<KnowledgeViewer> {
  const session = await getServerSession();
  if (!session) return { userId: null, role: null, canManage: false };
  const role = normalizeOrgRole(session.user.role);
  return {
    userId: session.user.id,
    role,
    canManage: canOrg(role, { knowledge: ["manage"] }),
  };
}

function readsKnowledge(viewer: KnowledgeViewer): viewer is KnowledgeViewer & {
  role: OrgRole;
} {
  return viewer.role !== null && canOrg(viewer.role, { knowledge: ["read"] });
}

/**
 * SQL predicate constraining a `knowledge_collections` row to what `viewer`
 * may see. `undefined` (knowledge:manage) means no constraint.
 */
export function visibleCollections(viewer: KnowledgeViewer): SQL | undefined {
  if (viewer.canManage) return undefined;
  if (!readsKnowledge(viewer)) return sql`false`;
  return sql`(cardinality(${knowledgeCollections.visibleToRoles}) = 0 OR ${viewer.role}::text = ANY(${knowledgeCollections.visibleToRoles}))`;
}

/** Same rule applied to an already-loaded collection. */
export function canViewCollection(
  collection: { visibleToRoles: string[] },
  viewer: KnowledgeViewer
): boolean {
  if (viewer.canManage) return true;
  if (!readsKnowledge(viewer)) return false;
  return (
    collection.visibleToRoles.length === 0 ||
    collection.visibleToRoles.includes(viewer.role)
  );
}

/**
 * SQL predicate constraining a `knowledge_documents` row (referenced by its
 * table name, so raw queries must not alias it) to what `viewer` may see: the
 * collection rule, then the draft rule. `undefined` (knowledge:manage) means
 * no constraint.
 */
export function visibleDocs(viewer: KnowledgeViewer): SQL | undefined {
  if (viewer.canManage) return undefined;
  return and(
    sql`${knowledgeDocuments.collectionId} IN (SELECT ${knowledgeCollections.id} FROM ${knowledgeCollections} WHERE ${visibleCollections(viewer)})`,
    or(
      isNotNull(knowledgeDocuments.publishedAt),
      // `false` literal when anonymous so only published rows match.
      viewer.userId
        ? eq(knowledgeDocuments.createdById, viewer.userId)
        : sql`false`
    )
  );
}

/** Same rule applied to an already-loaded row and its collection. */
export function canViewDoc(
  doc: {
    publishedAt: Date | null;
    createdById: string | null;
    collection: { visibleToRoles: string[] };
  },
  viewer: KnowledgeViewer
): boolean {
  if (!canViewCollection(doc.collection, viewer)) return false;
  return (
    doc.publishedAt !== null ||
    viewer.canManage ||
    (viewer.userId !== null && doc.createdById === viewer.userId)
  );
}

/** Whether the document `id` exists and `viewer` may see it (one query). */
async function isDocVisible(
  id: string,
  viewer: KnowledgeViewer
): Promise<boolean> {
  const [row] = await db
    .select({ id: knowledgeDocuments.id })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, id), visibleDocs(viewer)))
    .limit(1);
  return row !== undefined;
}

// --- Text helpers -----------------------------------------------------------

export {
  extractLinkedSlugs,
  markdownToPlainText,
  slugify,
} from "@/lib/knowledge-text";

// --- Read-side loaders ------------------------------------------------------

/** The collections the viewer may see, ordered for the tree sidebar. */
export async function loadCollections(
  // Session-free callers pass the viewer explicitly.
  viewerOverride?: KnowledgeViewer
): Promise<KnowledgeCollection[]> {
  const viewer = viewerOverride ?? (await currentViewer());
  return db
    .select()
    .from(knowledgeCollections)
    .where(visibleCollections(viewer))
    .orderBy(asc(knowledgeCollections.rank), asc(knowledgeCollections.name));
}

/**
 * Flat list of tree nodes for a collection (or all collections when omitted) —
 * body-free, ordered by (parent, rank) so the client can assemble the nesting
 * cheaply. Documents the viewer can't see (hidden collections, others' drafts)
 * are filtered out here (see visibleDocs).
 */
export async function loadTreeNodes(
  collectionId?: string,
  viewerOverride?: KnowledgeViewer
): Promise<KnowledgeTreeNode[]> {
  const viewer = viewerOverride ?? (await currentViewer());
  return db
    .select({
      id: knowledgeDocuments.id,
      collectionId: knowledgeDocuments.collectionId,
      parentId: knowledgeDocuments.parentId,
      title: knowledgeDocuments.title,
      docType: knowledgeDocuments.docType,
      slug: knowledgeDocuments.slug,
      rank: knowledgeDocuments.rank,
      publishedAt: knowledgeDocuments.publishedAt,
    })
    .from(knowledgeDocuments)
    .where(
      and(
        collectionId
          ? eq(knowledgeDocuments.collectionId, collectionId)
          : undefined,
        visibleDocs(viewer)
      )
    )
    .orderBy(asc(knowledgeDocuments.rank), asc(knowledgeDocuments.title));
}

// The reader's relations. The collection's visibility list is loaded for the
// check and stripped before the document leaves this module.
const documentWith = {
  collection: {
    columns: { id: true, name: true, icon: true, visibleToRoles: true },
  },
  createdBy: { columns: { id: true, name: true } },
  updatedBy: { columns: { id: true, name: true, image: true } },
} as const;

async function loadVisibleDocument(
  where: { slug: string } | { id: string },
  viewerOverride: KnowledgeViewer | undefined
): Promise<KnowledgeDocumentWithMeta | null> {
  const doc = await db.query.knowledgeDocuments.findFirst({
    where,
    with: documentWith,
  });
  // The FK makes the collection non-null; the relation type does not know it.
  if (!doc?.collection) return null;
  const viewer = viewerOverride ?? (await currentViewer());
  if (!canViewDoc({ ...doc, collection: doc.collection }, viewer)) return null;
  const { visibleToRoles: _, ...collection } = doc.collection;
  return { ...doc, collection } as KnowledgeDocumentWithMeta;
}

/**
 * Load one document by slug with author/collection metadata for the reader.
 * Slugs are globally unique (see the unique index), so the lookup is
 * deterministic. Returns null for a document the viewer may not see (hidden
 * collection, someone else's draft), so the route treats it exactly like a
 * missing doc (notFound) — no title leak.
 */
export async function loadDocumentBySlug(
  slug: string,
  // Session-free callers (the assistant worker) pass the viewer explicitly.
  viewerOverride?: KnowledgeViewer
): Promise<KnowledgeDocumentWithMeta | null> {
  return loadVisibleDocument({ slug }, viewerOverride);
}

export async function loadDocumentById(
  id: string,
  viewerOverride?: KnowledgeViewer
): Promise<KnowledgeDocumentWithMeta | null> {
  return loadVisibleDocument({ id }, viewerOverride);
}

/** A document's revisions, newest first, with the editor's display name. */
export type RevisionWithEditor = KnowledgeRevision & {
  editedBy: { id: string; name: string; image: string | null } | null;
};

/** Empty for a document the viewer may not see, like for a missing one. */
export async function loadRevisions(
  documentId: string,
  viewerOverride?: KnowledgeViewer
): Promise<RevisionWithEditor[]> {
  const viewer = viewerOverride ?? (await currentViewer());
  if (!(await isDocVisible(documentId, viewer))) return [];
  const rows = await db.query.knowledgeRevisions.findMany({
    where: { documentId },
    with: { editedBy: { columns: { id: true, name: true, image: true } } },
    orderBy: { createdAt: "desc" },
    limit: 100,
  });
  return rows as RevisionWithEditor[];
}

export type Backlink = { id: string; title: string; slug: string };

/**
 * Documents that link TO the given document, for the "Referenced by" panel.
 * Both ends are gated: a hidden target answers no backlinks at all, and a
 * hidden source (its title would leak) is left out.
 */
export async function loadBacklinks(
  documentId: string,
  viewerOverride?: KnowledgeViewer
): Promise<Backlink[]> {
  const viewer = viewerOverride ?? (await currentViewer());
  if (!(await isDocVisible(documentId, viewer))) return [];
  return db
    .select({
      id: knowledgeDocuments.id,
      title: knowledgeDocuments.title,
      slug: knowledgeDocuments.slug,
    })
    .from(knowledgeLinks)
    .innerJoin(
      knowledgeDocuments,
      eq(knowledgeDocuments.id, knowledgeLinks.fromDocumentId)
    )
    .where(
      and(eq(knowledgeLinks.toDocumentId, documentId), visibleDocs(viewer))
    )
    .orderBy(asc(knowledgeDocuments.title));
}

export type SearchHit = {
  id: string;
  title: string;
  slug: string;
  collectionId: string;
  snippet: string;
  rank: number;
};

// Highlight delimiters for ts_headline. Control chars (not <mark>) so the
// snippet is never interpreted as HTML — the client splits on these and wraps
// the spans itself, so a document containing literal "<script>" can't inject.
export const HL_START = String.fromCharCode(1);
export const HL_STOP = String.fromCharCode(2);

/**
 * Full-text search over the generated `search_vector`. Uses
 * websearch_to_tsquery (Google-style operators, never throws on bad syntax) and
 * ts_headline for a highlighted snippet. Ranked by ts_rank, capped at 20.
 */
export async function searchDocuments(
  query: string,
  // Session-free callers (the assistant worker) pass the viewer explicitly.
  viewerOverride?: KnowledgeViewer
): Promise<SearchHit[]> {
  const viewer = viewerOverride ?? (await currentViewer());
  // Keep what the viewer may not see out of the results — and out of the
  // ranking, so the hit list never differs by a hidden document. visibleDocs
  // names the table, so the FROM below must not alias it.
  const visible = visibleDocs(viewer);
  const rows = await db.execute<SearchHit>(sql`
    SELECT
      knowledge_documents.id,
      knowledge_documents.title,
      knowledge_documents.slug,
      knowledge_documents.collection_id AS "collectionId",
      ts_headline(
        'simple',
        knowledge_documents.content_text,
        websearch_to_tsquery('simple', ${query}),
        ${`MaxFragments=2,MinWords=5,MaxWords=18,StartSel=${HL_START},StopSel=${HL_STOP}`}
      ) AS snippet,
      ts_rank(knowledge_documents.search_vector, websearch_to_tsquery('simple', ${query})) AS rank
    FROM knowledge_documents
    WHERE knowledge_documents.search_vector @@ websearch_to_tsquery('simple', ${query})
    ${visible ? sql`AND ${visible}` : sql``}
    ORDER BY rank DESC
    LIMIT 20
  `);
  return rows as unknown as SearchHit[];
}

/**
 * Resolve a GLOBALLY unique slug by appending `-2`, `-3`, … when the base is
 * taken. Slugs are unique across all collections (not per-collection) so the
 * `/knowledge/<slug>` link a doc body carries resolves to exactly one document —
 * no cross-collection ambiguity in the backlink graph. Excludes `excludeId` so
 * renaming a doc to its own slug is a no-op. SERVER-ONLY: races are tolerable —
 * the unique index is the real guard and the action retries.
 */
export async function ensureUniqueSlug(
  base: string,
  excludeId?: string
): Promise<string> {
  let candidate = base;
  let n = 1;
  while (true) {
    const clash = await db.query.knowledgeDocuments.findFirst({
      where: { slug: candidate },
      columns: { id: true },
    });
    if (!clash || clash.id === excludeId) return candidate;
    n += 1;
    candidate = `${base}-${n}`.slice(0, 160).replace(/-+$/g, "");
  }
}

/**
 * Resolve `/knowledge/<slug>` links to ids in one query, as `viewer` sees
 * them: a slug of a document they may not see is absent, like a missing one.
 * (The backlink graph itself is stored for every target and filtered on read;
 * see rebuildLinks in server/services/knowledge.)
 */
export async function resolveSlugIds(
  slugs: string[],
  viewerOverride?: KnowledgeViewer
): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const viewer = viewerOverride ?? (await currentViewer());
  const rows = await db
    .select({
      id: knowledgeDocuments.id,
      slug: knowledgeDocuments.slug,
    })
    .from(knowledgeDocuments)
    .where(and(inArray(knowledgeDocuments.slug, slugs), visibleDocs(viewer)));
  return new Map(rows.map((r) => [r.slug, r.id]));
}

/** An attachment's object location, as the asset route serves it. */
export type VisibleAttachment = { storageKey: string; mime: string };

/**
 * The attachment `id` if `viewer` may fetch it: they hold knowledge:manage,
 * uploaded it, or a document visible to them references
 * `/api/knowledge/asset/<id>` in its body (the body is the source of truth for
 * which document uses an asset). Null otherwise, like a missing id — an image
 * used only inside a hidden document is not served.
 */
export async function loadVisibleAttachment(
  id: string,
  viewerOverride?: KnowledgeViewer
): Promise<VisibleAttachment | null> {
  const row = await db.query.knowledgeAttachments.findFirst({
    where: { id },
    columns: { storageKey: true, mime: true, uploadedById: true },
  });
  if (!row) return null;
  const viewer = viewerOverride ?? (await currentViewer());
  const attachment = { storageKey: row.storageKey, mime: row.mime };
  if (viewer.canManage) return attachment;
  if (viewer.userId !== null && row.uploadedById === viewer.userId) {
    return attachment;
  }
  const [used] = await db
    .select({ id: knowledgeDocuments.id })
    .from(knowledgeDocuments)
    .where(
      and(
        sql`strpos(${knowledgeDocuments.content}, ${`/api/knowledge/asset/${id}`}) > 0`,
        visibleDocs(viewer)
      )
    )
    .limit(1);
  return used ? attachment : null;
}

/**
 * Fractional-index rank for a new document appended after a parent's last
 * sibling. Reads only the greatest existing rank in the group (one indexed
 * row), so creation never touches or renumbers the other siblings.
 */
export async function appendDocumentRank(
  collectionId: string,
  parentId: string | null
): Promise<string> {
  const [row] = await db
    .select({ rank: knowledgeDocuments.rank })
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.collectionId, collectionId),
        parentId
          ? eq(knowledgeDocuments.parentId, parentId)
          : isNull(knowledgeDocuments.parentId)
      )
    )
    .orderBy(desc(knowledgeDocuments.rank))
    .limit(1);
  return generateKeyBetween(row?.rank ?? null, null);
}

/** Rank for a new collection appended after the last existing one. */
export async function appendCollectionRank(): Promise<string> {
  const [row] = await db
    .select({ rank: knowledgeCollections.rank })
    .from(knowledgeCollections)
    .orderBy(desc(knowledgeCollections.rank))
    .limit(1);
  return generateKeyBetween(row?.rank ?? null, null);
}
