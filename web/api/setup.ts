import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type { NewEnvironmentInput } from "@/lib/setup/new-environment";
import type { EnvironmentSetupInput } from "@/lib/setup/schema";
import { api, NO_REFETCH } from "@/web/api/client";
import { REMOTE_PROBE } from "@/web/query-client";

const routes = api.api.setup;

/**
 * Runs every check of a setup without writing. A POST only because the input
 * is too big for a query string, so it opts out of the refetch.
 */
export async function previewEnvironmentSetup(input: EnvironmentSetupInput) {
  return parseResponse(
    routes.environments.preview.$post({ json: input }, NO_REFETCH)
  );
}

export type SetupPreview = Awaited<ReturnType<typeof previewEnvironmentSetup>>;

/** The preview of an input; keeps the last answer while a new one loads. */
export const setupPreviewQuery = (input: EnvironmentSetupInput | null) =>
  queryOptions({
    queryKey: ["setup", "preview", input],
    queryFn: () => previewEnvironmentSetup(input as EnvironmentSetupInput),
    enabled: input !== null,
    placeholderData: keepPreviousData,
    retry: false,
    gcTime: 60_000,
  });

export async function createEnvironmentSetup(input: EnvironmentSetupInput) {
  return parseResponse(routes.environments.$post({ json: input }));
}

export async function getCopySource(id: string) {
  return parseResponse(
    routes.environments["copy-source"][":id"].$get({ param: { id } })
  );
}

export const copySourceQuery = (id: string) =>
  queryOptions({
    queryKey: ["setup", "copy-source", id],
    queryFn: () => getCopySource(id),
  });

export type CopySource = Awaited<ReturnType<typeof getCopySource>>;

export const setupOptionsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["setup", "options", projectId],
    queryFn: () => parseResponse(routes.options.$get({ query: { projectId } })),
  });

export type SetupOptions = Awaited<
  ReturnType<NonNullable<ReturnType<typeof setupOptionsQuery>["queryFn"]>>
>;

// Calls the Cloudflare API on every fetch.
export const setupAccessPoliciesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["setup", "access-policies", projectId],
    queryFn: () =>
      parseResponse(routes["access-policies"].$get({ query: { projectId } })),
    ...REMOTE_PROBE,
  });

export async function detectRepo(
  connectionId: string,
  repo: string,
  branch: string
) {
  return parseResponse(
    routes.detect.$get({ query: { connectionId, repo, branch } })
  );
}

export type RepoDetectionResult = Awaited<ReturnType<typeof detectRepo>>;

/** What a repository's branch offers the wizard (compose services, Dockerfiles). */
export const detectRepoQuery = (
  connectionId: string | null,
  repo: string | null,
  branch: string | null
) =>
  queryOptions({
    queryKey: ["setup", "detect", connectionId, repo, branch],
    queryFn: () =>
      detectRepo(connectionId as string, repo as string, branch as string),
    enabled: connectionId !== null && repo !== null && branch !== null,
    retry: false,
    staleTime: 60_000,
  });

/**
 * The New environment page's check: the short input resolved into a setup
 * (`plan`) and that setup's preview (null while the plan has issues). Writes
 * nothing; a POST for the same reason as the setup preview.
 */
export async function previewNewEnvironment(input: NewEnvironmentInput) {
  return parseResponse(
    routes["new-environment"].preview.$post({ json: input }, NO_REFETCH)
  );
}

export type NewEnvironmentPreview = Awaited<
  ReturnType<typeof previewNewEnvironment>
>;

export async function createNewEnvironment(input: NewEnvironmentInput) {
  return parseResponse(routes["new-environment"].$post({ json: input }));
}

/** The CI server's repositories whose name contains `q`, with their app. */
export const setupReposQuery = (q: string) =>
  queryOptions({
    queryKey: ["setup", "repos", q],
    queryFn: () => parseResponse(routes.repos.$get({ query: { q } })),
    retry: false,
    staleTime: 60_000,
  });

export type SetupRepoRow = Awaited<
  ReturnType<NonNullable<ReturnType<typeof setupReposQuery>["queryFn"]>>
>[number];
