import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api["project-sources"];
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listProjectSources(projectId: string) {
  return parseResponse(
    routes["list-project-sources"].$get({ query: { projectId } })
  );
}

export const listProjectSourcesQuery = (
  ...args: Parameters<typeof listProjectSources>
) =>
  queryOptions({
    queryKey: ["project-sources", "listProjectSources", args],
    queryFn: () => listProjectSources(...args),
  });

export async function addProjectSource(
  input: Body<"add-project-source">["input"]
) {
  return orFailure(
    () =>
      parseResponse(routes["add-project-source"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function removeProjectSource(
  input: Body<"remove-project-source">["input"]
) {
  return orFailure(
    () =>
      parseResponse(routes["remove-project-source"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function setComponentBranch(
  input: Body<"set-component-branch">["input"]
) {
  return orFailure(
    () =>
      parseResponse(routes["set-component-branch"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export type ProjectSourceRow = Awaited<
  ReturnType<typeof listProjectSources>
>[number];
