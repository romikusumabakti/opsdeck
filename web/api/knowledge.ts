import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api.knowledge;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function searchKnowledge(query: string) {
  return parseResponse(routes["search-knowledge"].$get({ query: { query } }));
}

export const searchKnowledgeQuery = (
  ...args: Parameters<typeof searchKnowledge>
) =>
  queryOptions({
    queryKey: ["knowledge", "searchKnowledge", args],
    queryFn: () => searchKnowledge(...args),
  });

export async function getBacklinks(documentId: string) {
  return parseResponse(routes["get-backlinks"].$get({ query: { documentId } }));
}

export const getBacklinksQuery = (...args: Parameters<typeof getBacklinks>) =>
  queryOptions({
    queryKey: ["knowledge", "getBacklinks", args],
    queryFn: () => getBacklinks(...args),
  });

export async function createCollection(
  data: Body<"create-collection">["data"]
) {
  return orFailure(
    () => parseResponse(routes["create-collection"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function updateCollection(
  id: Body<"update-collection">["id"],
  data: Body<"update-collection">["data"]
) {
  return orFailure(
    () =>
      parseResponse(routes["update-collection"].$post({ json: { id, data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteCollection(id: Body<"delete-collection">["id"]) {
  return orFailure(
    () => parseResponse(routes["delete-collection"].$post({ json: { id } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function moveCollection(data: Body<"move-collection">["data"]) {
  return orFailure(
    () => parseResponse(routes["move-collection"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function createDocument(data: Body<"create-document">["data"]) {
  return orFailure(
    () => parseResponse(routes["create-document"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function updateDocument(
  id: Body<"update-document">["id"],
  data: Body<"update-document">["data"]
) {
  return orFailure(
    () =>
      parseResponse(routes["update-document"].$post({ json: { id, data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function moveDocument(data: Body<"move-document">["data"]) {
  return orFailure(
    () => parseResponse(routes["move-document"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteDocument(id: Body<"delete-document">["id"]) {
  return orFailure(
    () => parseResponse(routes["delete-document"].$post({ json: { id } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function restoreRevision(
  documentId: Body<"restore-revision">["documentId"],
  revisionId: Body<"restore-revision">["revisionId"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["restore-revision"].$post({ json: { documentId, revisionId } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

// Page data (server/routes/knowledge.ts): what the knowledge pages read
// straight from lib/knowledge under Next.

/** Every collection, for the sidebar and the pickers. */
export async function listCollections() {
  return parseResponse(routes.collections.$get());
}

export const listCollectionsQuery = (
  ...args: Parameters<typeof listCollections>
) =>
  queryOptions({
    queryKey: ["knowledge", "listCollections", args],
    queryFn: () => listCollections(...args),
  });

/** The document tree (titles, slugs, parents) for the sidebar and links. */
export async function listTreeNodes() {
  return parseResponse(routes.tree.$get());
}

export const listTreeNodesQuery = (...args: Parameters<typeof listTreeNodes>) =>
  queryOptions({
    queryKey: ["knowledge", "listTreeNodes", args],
    queryFn: () => listTreeNodes(...args),
  });

/** One document by slug; rejects with a 404 ApiError when it is hidden. */
export async function getDocument(slug: string) {
  return parseResponse(routes.documents[":slug"].$get({ param: { slug } }));
}

export const getDocumentQuery = (...args: Parameters<typeof getDocument>) =>
  queryOptions({
    queryKey: ["knowledge", "getDocument", args],
    queryFn: () => getDocument(...args),
  });

/** A document's revision history (needs knowledge:write, as the page did). */
export async function listRevisions(slug: string) {
  return parseResponse(
    routes.documents[":slug"].revisions.$get({ param: { slug } })
  );
}

export const listRevisionsQuery = (...args: Parameters<typeof listRevisions>) =>
  queryOptions({
    queryKey: ["knowledge", "listRevisions", args],
    queryFn: () => listRevisions(...args),
  });
