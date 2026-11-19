import type { QueryClient } from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";
import { canOrg } from "@/lib/permissions";
import { ApiError } from "@/web/api/client";
import { s3ConnectionLocationQuery } from "@/web/api/s3-connections";
import { meQuery } from "@/web/api/session";

// Where the removed global Storage URLs (/storage, /storage/new,
// /storage/<id>, /storage/<id>/files) now lead. The server says where a
// connection is managed (get-s3-connection-location): its environment's
// Storage page for whoever may view that environment, Admin › Storage for an
// unassigned one (the instance backup bucket included) for the roles that
// manage storage, and a 404 for everyone else.

/** The list and create URLs: Admin › Storage for admins, else Home. */
export async function legacyStorageIndexHref(
  queryClient: QueryClient
): Promise<string> {
  const me = await queryClient.query(meQuery());
  return canOrg(me?.orgRole, { storage: ["manage"] }) ? "/admin/storage" : "/";
}

/** A connection URL; `suffix` is "" (its page) or "/files" (its browser). */
export async function legacyStorageConnectionHref(
  queryClient: QueryClient,
  id: string,
  suffix: "" | "/files"
): Promise<string> {
  const location = await queryClient
    .query(s3ConnectionLocationQuery(id))
    .catch((error: unknown) => {
      // A malformed id, or a connection the caller can't reach.
      if (error instanceof ApiError && [400, 403, 404].includes(error.status)) {
        throw notFound();
      }
      throw error;
    });
  if (location.kind === "admin") return "/admin/storage";
  return `/${location.projectKey}/${location.envSlug}/storage/${id}${suffix}`;
}
