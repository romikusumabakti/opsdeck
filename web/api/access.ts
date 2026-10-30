import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api.access;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function getAccessMatrix() {
  return parseResponse(routes["get-access-matrix"].$get());
}

export const getAccessMatrixQuery = (
  ...args: Parameters<typeof getAccessMatrix>
) =>
  queryOptions({
    queryKey: ["access", "getAccessMatrix", args],
    queryFn: () => getAccessMatrix(...args),
  });

export async function offboardUser(userId: Body<"offboard-user">["userId"]) {
  return orFailure(
    () => parseResponse(routes["offboard-user"].$post({ json: { userId } })),
    (message) => ({ success: false, message }) as const
  );
}

export type AccessMatrix = Awaited<ReturnType<typeof getAccessMatrix>>;
