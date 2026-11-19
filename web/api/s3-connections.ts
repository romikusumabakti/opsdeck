import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, type PostJson } from "@/web/api/client";

const routes = api.api["s3-connections"];
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

/**
 * Where an old /storage/<id> link leads: the connection's environment, or
 * Admin › Storage for an unassigned one. Rejects with a 404 ApiError for a
 * connection the caller can't reach (or that does not exist).
 */
export async function getS3ConnectionLocation(id: string) {
  return parseResponse(
    routes["get-s3-connection-location"].$get({ query: { id } })
  );
}

export const s3ConnectionLocationQuery = (id: string) =>
  queryOptions({
    queryKey: ["s3-connections", "getS3ConnectionLocation", id],
    queryFn: () => getS3ConnectionLocation(id),
  });

export type S3ConnectionRow = Awaited<
  ReturnType<typeof listUnassignedS3Connections>
>[number];

// Admin › Storage: connections no environment owns (org storage:manage).
export async function listUnassignedS3Connections() {
  return parseResponse(routes["list-unassigned-s3-connections"].$get());
}

export const unassignedS3ConnectionsQuery = () =>
  queryOptions({
    queryKey: ["s3-connections", "listUnassignedS3Connections"],
    queryFn: () => listUnassignedS3Connections(),
  });

/** Rejects with an ApiError (404 missing; 409 `s3BackupDestinationNotAssignable`). */
export async function assignS3Connection(
  id: Body<"assign-s3-connection">["id"],
  environmentId: Body<"assign-s3-connection">["environmentId"]
) {
  return parseResponse(
    routes["assign-s3-connection"].$post({ json: { id, environmentId } })
  );
}

export async function deleteUnassignedS3Connection(
  id: Body<"delete-unassigned-s3-connection">["id"]
) {
  return parseResponse(
    routes["delete-unassigned-s3-connection"].$post({ json: { id } })
  );
}
