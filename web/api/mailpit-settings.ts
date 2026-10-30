import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api["mailpit-settings"];
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function getMailpitSettings(environmentId: string) {
  return parseResponse(
    routes["get-mailpit-settings"].$get({ query: { environmentId } })
  );
}

export const getMailpitSettingsQuery = (
  ...args: Parameters<typeof getMailpitSettings>
) =>
  queryOptions({
    queryKey: ["mailpit-settings", "getMailpitSettings", args],
    queryFn: () => getMailpitSettings(...args),
  });

export async function saveMailpitSettings(
  environmentId: Body<"save-mailpit-settings">["environmentId"],
  data: Body<"save-mailpit-settings">["data"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["save-mailpit-settings"].$post({ json: { environmentId, data } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function testMailpitConnection(
  environmentId: Body<"test-mailpit-connection">["environmentId"],
  data: Body<"test-mailpit-connection">["data"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["test-mailpit-connection"].$post({
          json: { environmentId, data },
        })
      ),
    (message) => ({ success: false, error: message }) as const
  );
}
