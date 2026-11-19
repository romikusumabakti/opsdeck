import type { QueryClient } from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";
import { canOrg } from "@/lib/permissions";
import { ApiError } from "@/web/api/client";
import { listEnvironmentsQuery } from "@/web/api/environments";
import { getS3ConnectionQuery } from "@/web/api/s3-connections";
import { meQuery } from "@/web/api/session";

// Where the removed global Storage URLs (/storage, /storage/new,
// /storage/<id>, /storage/<id>/files) now lead. An assigned connection goes
// to its environment's Storage page; an unassigned one to Admin › Storage,
// for the roles that manage storage, and is a 404 for everyone else.

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
  const me = await queryClient.query(meQuery());
  const connection = await queryClient
    .query(getS3ConnectionQuery(id))
    .catch((error: unknown) => {
      // Roles without the org storage right cannot look a connection up by
      // id: to them it is as good as missing.
      if (error instanceof ApiError && [403, 404].includes(error.status)) {
        throw notFound();
      }
      throw error;
    });
  if (!connection) throw notFound();
  if (connection.environmentId) {
    const environments = await queryClient.query(listEnvironmentsQuery());
    const environment = environments.find(
      (e) => e.id === connection.environmentId
    );
    if (!environment) throw notFound();
    return `/${environment.key}/${environment.slug}/storage/${id}${suffix}`;
  }
  if (!canOrg(me?.orgRole, { storage: ["manage"] })) throw notFound();
  return connection.isBackupDestination ? "/admin/instance" : "/admin/storage";
}
