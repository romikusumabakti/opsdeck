// Knowledge collections and documents, written the way the knowledge
// service saves them: markdown body, its plain-text projection, a
// fractional rank, a prior-version revision per edit, and backlink rows.
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import {
  knowledgeCollections,
  knowledgeDocuments,
  knowledgeLinks,
  knowledgeRevisions,
} from "@/lib/db/schema";
import { extractLinkedSlugs, markdownToPlainText } from "@/lib/knowledge-text";
import { DEMO_COLLECTIONS, DEMO_DOCUMENTS } from "../seed-data/knowledge";
import { addDays, addMinutes, workTime } from "../seed-data/random";
import { count, personId, type SeedContext } from "./context";

export async function seedKnowledge(ctx: SeedContext): Promise<void> {
  const { tx, now } = ctx;
  const collectionIds = new Map<string, string>();
  for (const collection of DEMO_COLLECTIONS) {
    const [existing] = await tx
      .select({ id: knowledgeCollections.id })
      .from(knowledgeCollections)
      .where(eq(knowledgeCollections.name, collection.name));
    if (existing) {
      collectionIds.set(collection.name, existing.id);
      continue;
    }
    const [last] = await tx
      .select({ rank: knowledgeCollections.rank })
      .from(knowledgeCollections)
      .orderBy(desc(knowledgeCollections.rank))
      .limit(1);
    const createdAt = addDays(now, -30);
    const [row] = await tx
      .insert(knowledgeCollections)
      .values({
        ...collection,
        rank: generateKeyBetween(last?.rank ?? null, null),
        createdById: personId(ctx, "fajar"),
        createdAt,
        updatedAt: createdAt,
      })
      .returning({ id: knowledgeCollections.id });
    if (!row) continue;
    count(ctx, "knowledgeCollections");
    collectionIds.set(collection.name, row.id);
  }

  const created: { id: string; content: string }[] = [];
  for (const doc of DEMO_DOCUMENTS) {
    const collectionId = collectionIds.get(doc.collection);
    if (!collectionId) continue;
    const [last] = await tx
      .select({ rank: knowledgeDocuments.rank })
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.collectionId, collectionId),
          isNull(knowledgeDocuments.parentId)
        )
      )
      .orderBy(desc(knowledgeDocuments.rank))
      .limit(1);
    const createdAt = workTime(now, doc.daysAgo, 60);
    const editedAt = doc.previous ? addDays(createdAt, 2) : createdAt;
    const authorId = personId(ctx, doc.author);
    const editorId = doc.previous
      ? personId(ctx, doc.previous.editor)
      : authorId;
    const [row] = await tx
      .insert(knowledgeDocuments)
      .values({
        collectionId,
        title: doc.title,
        docType: doc.docType,
        slug: doc.slug,
        content: doc.content,
        contentText: markdownToPlainText(doc.content),
        rank: generateKeyBetween(last?.rank ?? null, null),
        version: doc.previous ? 1 : 0,
        publishedAt: doc.published ? addMinutes(createdAt, 30) : null,
        projectId: doc.project
          ? (ctx.projects.get(doc.project)?.id ?? null)
          : null,
        createdById: authorId,
        updatedById: editorId,
        createdAt,
        updatedAt: editedAt,
      })
      .onConflictDoNothing()
      .returning({ id: knowledgeDocuments.id });
    if (!row) continue;
    count(ctx, "knowledgeDocuments");
    created.push({ id: row.id, content: doc.content });
    if (doc.previous) {
      await tx.insert(knowledgeRevisions).values({
        documentId: row.id,
        title: doc.previous.title,
        content: doc.previous.content,
        editedById: editorId,
        createdAt: editedAt,
      });
      count(ctx, "knowledgeRevisions");
    }
  }

  // Backlinks of the documents created now, as a save rebuilds them.
  for (const doc of created) {
    const slugs = extractLinkedSlugs(doc.content);
    if (slugs.length === 0) continue;
    const targets = await tx
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(inArray(knowledgeDocuments.slug, slugs));
    const edges = targets
      .filter((t) => t.id !== doc.id)
      .map((t) => ({ fromDocumentId: doc.id, toDocumentId: t.id }));
    if (edges.length === 0) continue;
    const added = await tx
      .insert(knowledgeLinks)
      .values(edges)
      .onConflictDoNothing()
      .returning({ to: knowledgeLinks.toDocumentId });
    count(ctx, "knowledgeLinks", added.length);
  }
}
