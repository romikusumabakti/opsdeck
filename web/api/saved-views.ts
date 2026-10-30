import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api["saved-views"];
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listSavedViews() {
  return parseResponse(routes["list-saved-views"].$get());
}

export const listSavedViewsQuery = (
  ...args: Parameters<typeof listSavedViews>
) =>
  queryOptions({
    queryKey: ["saved-views", "listSavedViews", args],
    queryFn: () => listSavedViews(...args),
  });

export async function createSavedView(
  name: Body<"create-saved-view">["name"],
  params: Body<"create-saved-view">["params"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["create-saved-view"].$post({ json: { name, params } })
      ),
    () => ({ success: false }) as const
  );
}

export async function deleteSavedView(id: Body<"delete-saved-view">["id"]) {
  return orFailure(
    () => parseResponse(routes["delete-saved-view"].$post({ json: { id } })),
    () => ({ success: false }) as const
  );
}
