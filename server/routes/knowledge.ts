import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireOrgPermission, routeOrgGuard } from "@/lib/authz";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import { knowledgeAttachments } from "@/lib/db/schema";
import { sniffImage } from "@/lib/image-sniff";
import { imgproxyUrl } from "@/lib/imgproxy";
import {
  loadCollections,
  loadDocumentBySlug,
  loadRevisions,
  loadTreeNodes,
} from "@/lib/knowledge";
import { putObject } from "@/lib/storage";
import {
  collectionInputSchema,
  collectionMoveSchema,
  collectionUpdateSchema,
  documentInputSchema,
  documentMoveSchema,
  documentUpdateSchema,
  KNOWLEDGE_IMAGE_MAX_BYTES,
  knowledgeIdSchema,
} from "@/lib/validation";
import { notFound } from "@/server/errors";
import { sessionRouter } from "@/server/router";
import {
  createCollection,
  createDocument,
  deleteCollection,
  deleteDocument,
  getBacklinks,
  moveCollection,
  moveDocument,
  restoreRevision,
  searchKnowledge,
  updateCollection,
  updateDocument,
} from "@/server/services/knowledge";
import { json, param, query } from "@/server/validation";

const byId = json(z.object({ id: knowledgeIdSchema }));
// Loose on purpose: the lookup is parameterized, and an odd slug should 404
// like any other missing document rather than fail validation.
const bySlug = param(z.object({ slug: z.string().min(1).max(200) }));

export const knowledgeRouter = sessionRouter()
  // --- Page data (knowledge layout and pages), straight from lib/knowledge.
  // Each route applies the guard its page did. Draft visibility is enforced
  // inside the loaders.
  .get("/collections", async (c) => {
    await requireOrgPermission({ knowledge: ["read"] });
    return c.json(await loadCollections());
  })
  .get("/tree", async (c) => {
    await requireOrgPermission({ knowledge: ["read"] });
    return c.json(await loadTreeNodes());
  })
  .get("/documents/:slug", bySlug, async (c) => {
    await requireOrgPermission({ knowledge: ["read"] });
    // A draft the caller may not see is null too: same 404, no title leak.
    const doc = await loadDocumentBySlug(c.req.valid("param").slug);
    if (!doc) notFound();
    return c.json(doc);
  })
  .get("/documents/:slug/revisions", bySlug, async (c) => {
    // The history page needs write, not just read.
    await requireOrgPermission({ knowledge: ["write"] });
    // Resolve through the slug loader so a hidden draft's history 404s too;
    // loadRevisions itself does not check visibility.
    const doc = await loadDocumentBySlug(c.req.valid("param").slug);
    if (!doc) notFound();
    return c.json(await loadRevisions(doc.id));
  })
  // --- Service reads
  .get(
    "/search-knowledge",
    // The service answers a blank or overlong query with no hits, which is
    // what the search box wants while the user types; only bound the size.
    query(z.object({ query: z.string().max(1000) })),
    async (c) => c.json(await searchKnowledge(c.req.valid("query").query))
  )
  .get(
    "/get-backlinks",
    query(z.object({ documentId: knowledgeIdSchema })),
    async (c) => c.json(await getBacklinks(c.req.valid("query").documentId))
  )
  // --- Mutations
  .post(
    "/create-collection",
    json(z.object({ data: collectionInputSchema })),
    async (c) => c.json(await createCollection(c.req.valid("json").data))
  )
  .post(
    "/update-collection",
    json(z.object({ id: knowledgeIdSchema, data: collectionUpdateSchema })),
    async (c) => {
      const { id, data } = c.req.valid("json");
      return c.json(await updateCollection(id, data));
    }
  )
  .post("/delete-collection", byId, async (c) =>
    c.json(await deleteCollection(c.req.valid("json").id))
  )
  .post(
    "/move-collection",
    json(z.object({ data: collectionMoveSchema })),
    async (c) => c.json(await moveCollection(c.req.valid("json").data))
  )
  .post(
    "/create-document",
    json(z.object({ data: documentInputSchema })),
    async (c) => c.json(await createDocument(c.req.valid("json").data))
  )
  .post(
    "/update-document",
    json(z.object({ id: knowledgeIdSchema, data: documentUpdateSchema })),
    async (c) => {
      const { id, data } = c.req.valid("json");
      return c.json(await updateDocument(id, data));
    }
  )
  .post(
    "/move-document",
    json(z.object({ data: documentMoveSchema })),
    async (c) => c.json(await moveDocument(c.req.valid("json").data))
  )
  .post("/delete-document", byId, async (c) =>
    c.json(await deleteDocument(c.req.valid("json").id))
  )
  .post(
    "/restore-revision",
    json(
      z.object({ documentId: knowledgeIdSchema, revisionId: knowledgeIdSchema })
    ),
    async (c) => {
      const { documentId, revisionId } = c.req.valid("json");
      return c.json(await restoreRevision(documentId, revisionId));
    }
  )
  // --- Ported from app/api/knowledge/asset/**. Same paths, because saved
  // document bodies link to /api/knowledge/asset/<id>; same responses.

  /**
   * Upload an image attachment. Through-app so auth is enforced here. The
   * ORIGINAL bytes are stored as-is in Garage; resizing/format conversion
   * happens on read via imgproxy (see the GET route). The app keeps no
   * image-processing code. Multipart, so no JSON validator.
   */
  .post("/asset", async (c) => {
    const guard = await routeOrgGuard({ knowledge: ["write"] });
    if (!guard.ok) return guard.response;
    const { session } = guard;

    const form = await c.req.raw.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "no_file" }, 400);
    }
    if (file.size > KNOWLEDGE_IMAGE_MAX_BYTES) {
      return c.json({ error: "too_large" }, 413);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const kind = sniffImage(bytes);
    if (!kind) {
      return c.json({ error: "unsupported_type" }, 415);
    }

    const id = randomUUID();
    const storageKey = `kb/${id}.${kind.ext}`;

    try {
      await putObject(storageKey, bytes, kind.mime);
    } catch (error) {
      console.error("Attachment upload to storage failed:", error);
      return c.json({ error: "storage" }, 502);
    }

    const row = one(
      await db
        .insert(knowledgeAttachments)
        .values({
          storageKey,
          mime: kind.mime,
          sizeBytes: bytes.byteLength,
          uploadedById: session.user.id,
        })
        .returning({ id: knowledgeAttachments.id }),
      "knowledge attachment"
    );

    return c.json({ id: row.id, url: `/api/knowledge/asset/${row.id}` });
  })
  /**
   * Serve an attachment. The markdown body links here by stable id (never a
   * raw storage/imgproxy URL), so the bucket and imgproxy both stay private
   * and every read is session-gated. We resolve id -> storage key, sign an
   * imgproxy URL, and proxy the transformed result back — the browser only
   * ever talks to the app.
   *
   * The browser's Accept header is forwarded so imgproxy can negotiate the
   * best format it supports (AVIF, then WebP, then the original).
   */
  .get("/asset/:id", async (c) => {
    const guard = await routeOrgGuard({ knowledge: ["read"] });
    if (!guard.ok) return guard.response;

    const id = c.req.param("id");
    if (!knowledgeIdSchema.safeParse(id).success) {
      return new Response("Bad request", { status: 400 });
    }

    const row = await db.query.knowledgeAttachments.findFirst({
      where: { id },
      columns: { storageKey: true, mime: true },
    });
    if (!row) return new Response("Not found", { status: 404 });

    let upstream: Response;
    try {
      upstream = await fetch(imgproxyUrl(row.storageKey), {
        headers: { Accept: c.req.header("accept") ?? "image/*" },
      });
    } catch (error) {
      console.error(`imgproxy fetch failed for ${id}:`, error);
      return new Response("Image service error", { status: 502 });
    }
    if (!upstream.ok || !upstream.body) {
      console.error(`imgproxy returned ${upstream.status} for ${id}`);
      return new Response("Image service error", { status: 502 });
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? row.mime,
        // Auth-gated but immutable bytes (key is a uuid); reuse within the
        // session.
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Disposition": "inline",
      },
    });
  });
