import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

// What the SPA needs before it renders anything (server/routes/session.ts).

/** The signed-in user (`{ user, orgRole, timeZone }`), or null. */
export async function getMe() {
  return parseResponse(api.api.me.$get());
}

export const meQuery = () =>
  queryOptions({ queryKey: ["session", "getMe"], queryFn: getMe });

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
  });
