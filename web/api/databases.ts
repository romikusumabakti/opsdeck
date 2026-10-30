import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";
import { REMOTE_PROBE } from "@/web/query-client";

const routes = api.api.databases;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function getDatabaseList(environmentId: string) {
  return orFailure(
    () =>
      parseResponse(
        routes["get-database-list"].$get({ query: { environmentId } })
      ),
    (message) => ({ success: false, error: message }) as const
  );
}

export const getDatabaseListQuery = (
  ...args: Parameters<typeof getDatabaseList>
) =>
  queryOptions({
    queryKey: ["databases", "getDatabaseList", args],
    queryFn: () => getDatabaseList(...args),
    ...REMOTE_PROBE,
  });

export async function createDatabase(
  environmentId: Body<"create-database">["environmentId"],
  options: Body<"create-database">["options"]
) {
  return parseResponse(
    routes["create-database"].$post({ json: { environmentId, options } })
  );
}

export async function dropDatabase(
  environmentId: Body<"drop-database">["environmentId"],
  options: Body<"drop-database">["options"]
) {
  return parseResponse(
    routes["drop-database"].$post({ json: { environmentId, options } })
  );
}

export async function renameDatabase(
  environmentId: Body<"rename-database">["environmentId"],
  options: Body<"rename-database">["options"]
) {
  return parseResponse(
    routes["rename-database"].$post({ json: { environmentId, options } })
  );
}

export type DatabaseEntry = Extract<
  Awaited<ReturnType<typeof getDatabaseList>>,
  { success: true }
>["data"][number];
