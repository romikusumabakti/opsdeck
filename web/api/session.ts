import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";
import { ME_QUERY_KEY, queryClient } from "@/web/query-client";

// What the SPA needs before it renders anything (server/routes/session.ts).

/** The signed-in user (`{ user, orgRole, timeZone }`), or null. */
export async function getMe() {
  return parseResponse(api.api.me.$get());
}

/**
 * The $locale gate reads this on every navigation through
 * `queryClient.query()`, which refetches once the entry is older than
 * staleTime. 10 seconds keeps quick page-to-page moves off the network while
 * a session revoked elsewhere is noticed within a few clicks; a 401 from any
 * API call clears the entry at once (web/api/client.ts).
 */
export const meQuery = () =>
  queryOptions({
    queryKey: ME_QUERY_KEY,
    queryFn: getMe,
    staleTime: 10_000,
  });

/** Deployment identity and flags: branding, Microsoft sign-in, app zone. */
export async function getBootstrap() {
  return parseResponse(api.api.bootstrap.$get());
}

export const bootstrapQuery = () =>
  queryOptions({
    queryKey: ["session", "getBootstrap"],
    queryFn: getBootstrap,
    // Fixed for the life of the server process.
    staleTime: Number.POSITIVE_INFINITY,
    meta: { fixed: true },
  });

/**
 * Call after better-auth signs a user in or out (or switches accounts).
 * Drops every cached query — all of it belonged to the previous session, and
 * none of it may leak into the next user's shell — then loads the new
 * `/api/me`, so the caller can navigate (and the $locale gate can decide)
 * with the fresh answer. Resolves to it: the user, or null when signed out.
 */
export async function resetSession(client = queryClient) {
  client.clear();
  return client.query(meQuery());
}
