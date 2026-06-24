import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type KnowledgeCollection,
  type KnowledgeDocumentWithMeta,
  type KnowledgeRevision,
  type KnowledgeTreeNode,
  knowledgeCollections,
  knowledgeDocuments,
} from "@/lib/db/schema";

// --- Text helpers -----------------------------------------------------------

/**
 * Derive a URL slug from a title: lowercase, ASCII-fold the common cases, and
 * collapse anything non-alphanumeric to single hyphens. Matches the shape
 * enforced by knowledgeSlugSchema. Empty result falls back to "untitled" so the
 * caller always gets a routable token to dedupe against.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    // strip combining marks left by NFKD so "café" -> "cafe"
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

/**
 * Strip markdown syntax to a plain-text approximation for the FTS column. Not a
 * full parser — drops code fences, link/image syntax, headings, emphasis, and
 * list/quote markers so search indexes words, not punctuation.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/^[\s>*+-]+/gm, " ") // list/quote/bullet markers
    .replace(/[*_~]+/g, "") // emphasis
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull the slugs of every internal document link in a markdown body. Recognizes
 * `/knowledge/<slug>` and `/<locale>/knowledge/<slug>` hrefs (locale-prefixed
 * routing). Returns a de-duplicated list; the caller resolves slugs to ids when
 * rebuilding the backlink graph.
 */
export function extractLinkedSlugs(markdown: string): string[] {
  const re = /\]\((?:\/[a-z]{2})?\/knowledge\/([a-z0-9-]+)\)/g;
  const slugs = new Set<string>();
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
  while ((m = re.exec(markdown)) !== null) {
    slugs.add(m[1]);
  }
  return [...slugs];
}

// --- Read-side loaders ------------------------------------------------------

/** All collections, ordered for the tree sidebar. */
export async function loadCollections(): Promise<KnowledgeCollection[]> {
  return db.query.knowledgeCollections.findMany({
    orderBy: { position: "asc", name: "asc" },
  });
}

/**
 * Flat list of tree nodes for a collection (or all collections when omitted) —
 * body-free, ordered by (parent, position) so the client can assemble the
 * nesting cheaply. Drafts are included; the caller hides them for non-authors.
 */
export async function loadTreeNodes(
  collectionId?: string
): Promise<KnowledgeTreeNode[]> {
  const rows = await db.query.knowledgeDocuments.findMany({
    where: collectionId ? { collectionId } : undefined,
    columns: {
      id: true,
      collectionId: true,
      parentId: true,
      title: true,
      slug: true,
      position: true,
      publishedAt: true,
    },
    orderBy: { position: "asc", title: "asc" },
  });
  return rows;
}

/**
 * Load one document by slug with author/collection metadata for the reader.
 * Slugs are unique per collection, not globally; when two collections share a
 * slug the first by id wins — link generation always uses the canonical
 * per-collection slug so cross-collection collisions are cosmetic only.
 */
export async function loadDocumentBySlug(
  slug: string
): Promise<KnowledgeDocumentWithMeta | null> {
  const doc = await db.query.knowledgeDocuments.findFirst({
    where: { slug },
    with: {
      collection: { columns: { id: true, name: true, icon: true } },
      createdBy: { columns: { id: true, name: true } },
      updatedBy: { columns: { id: true, name: true } },
    },
  });
  return (doc as KnowledgeDocumentWithMeta | undefined) ?? null;
}

export async function loadDocumentById(
  id: string
): Promise<KnowledgeDocumentWithMeta | null> {
  const doc = await db.query.knowledgeDocuments.findFirst({
    where: { id },
    with: {
      collection: { columns: { id: true, name: true, icon: true } },
      createdBy: { columns: { id: true, name: true } },
      updatedBy: { columns: { id: true, name: true } },
    },
  });
  return (doc as KnowledgeDocumentWithMeta | undefined) ?? null;
}

/** A document's revisions, newest first, with the editor's display name. */
export type RevisionWithEditor = KnowledgeRevision & {
  editedBy: { id: string; name: string } | null;
};

export async function loadRevisions(
  documentId: string
): Promise<RevisionWithEditor[]> {
  const rows = await db.query.knowledgeRevisions.findMany({
    where: { documentId },
    with: { editedBy: { columns: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    limit: 100,
  });
  return rows as RevisionWithEditor[];
}

export type Backlink = { id: string; title: string; slug: string };

/** Documents that link TO the given document, for the "Referenced by" panel. */
export async function loadBacklinks(documentId: string): Promise<Backlink[]> {
  const rows = await db.execute<Backlink>(sql`
    SELECT d.id, d.title, d.slug
    FROM knowledge_links l
    JOIN knowledge_documents d ON d.id = l.from_document_id
    WHERE l.to_document_id = ${documentId}
    ORDER BY d.title ASC
  `);
  return rows as unknown as Backlink[];
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
export async function searchDocuments(query: string): Promise<SearchHit[]> {
  const rows = await db.execute<SearchHit>(sql`
    SELECT
      d.id,
      d.title,
      d.slug,
      d.collection_id AS "collectionId",
      ts_headline(
        'simple',
        d.content_text,
        websearch_to_tsquery('simple', ${query}),
        ${`MaxFragments=2,MinWords=5,MaxWords=18,StartSel=${HL_START},StopSel=${HL_STOP}`}
      ) AS snippet,
      ts_rank(d.search_vector, websearch_to_tsquery('simple', ${query})) AS rank
    FROM knowledge_documents d
    WHERE d.search_vector @@ websearch_to_tsquery('simple', ${query})
    ORDER BY rank DESC
    LIMIT 20
  `);
  return rows as unknown as SearchHit[];
}

/**
 * Resolve a unique slug within a collection by appending `-2`, `-3`, … when the
 * base is taken. Excludes `excludeId` so renaming a doc to its own slug is a
 * no-op rather than a collision. SERVER-ONLY: races are tolerable for an
 * internal tool — the unique index is the real guard and the action retries.
 */
export async function ensureUniqueSlug(
  collectionId: string,
  base: string,
  excludeId?: string
): Promise<string> {
  let candidate = base;
  let n = 1;
  while (true) {
    const clash = await db.query.knowledgeDocuments.findFirst({
      where: { collectionId, slug: candidate },
      columns: { id: true },
    });
    if (!clash || clash.id === excludeId) return candidate;
    n += 1;
    candidate = `${base}-${n}`.slice(0, 160).replace(/-+$/g, "");
  }
}

/** Resolve a set of slugs to ids in one query (backlink rebuild). */
export async function resolveSlugIds(
  slugs: string[]
): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select({
      id: knowledgeDocuments.id,
      slug: knowledgeDocuments.slug,
    })
    .from(knowledgeDocuments)
    .where(
      and(
        sql`${knowledgeDocuments.slug} = ANY(${slugs})`,
        // exclude soft constraints later if needed
        sql`true`
      )
    );
  return new Map(rows.map((r) => [r.slug, r.id]));
}

/** Next sibling position for a new document under a parent. */
export async function nextPosition(
  collectionId: string,
  parentId: string | null
): Promise<number> {
  const [row] = await db
    .select({
      max: sql<number>`coalesce(max(${knowledgeDocuments.position}), -1)`,
    })
    .from(knowledgeDocuments)
    .where(
      parentId
        ? and(
            eq(knowledgeDocuments.collectionId, collectionId),
            eq(knowledgeDocuments.parentId, parentId)
          )
        : and(
            eq(knowledgeDocuments.collectionId, collectionId),
            sql`${knowledgeDocuments.parentId} IS NULL`
          )
    );
  return (row?.max ?? -1) + 1;
}

/** Next position among top-level collections. */
export async function nextCollectionPosition(): Promise<number> {
  const [row] = await db
    .select({
      max: sql<number>`coalesce(max(${knowledgeCollections.position}), -1)`,
    })
    .from(knowledgeCollections);
  return (row?.max ?? -1) + 1;
}
