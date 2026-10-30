import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";
import { REMOTE_PROBE } from "@/web/query-client";

const routes = api.api.backups;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function getBackupList(environmentId: string) {
  return orFailure(
    () =>
      parseResponse(
        routes["get-backup-list"].$get({ query: { environmentId } })
      ),
    (message) => ({ success: false, error: message }) as const
  );
}

export const getBackupListQuery = (...args: Parameters<typeof getBackupList>) =>
  queryOptions({
    queryKey: ["backups", "getBackupList", args],
    queryFn: () => getBackupList(...args),
    ...REMOTE_PROBE,
  });

export async function createDatabaseBackup(
  environmentId: Body<"create-database-backup">["environmentId"],
  options?: Body<"create-database-backup">["options"]
) {
  return parseResponse(
    routes["create-database-backup"].$post({ json: { environmentId, options } })
  );
}

export async function restoreDatabaseBackup(
  environmentId: Body<"restore-database-backup">["environmentId"],
  options: Body<"restore-database-backup">["options"]
) {
  return parseResponse(
    routes["restore-database-backup"].$post({
      json: { environmentId, options },
    })
  );
}
