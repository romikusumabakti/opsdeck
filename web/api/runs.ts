import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

const routes = api.api.runs;

export async function getEnvironmentsLastActivity() {
  return parseResponse(routes["get-environments-last-activity"].$get());
}

export const getEnvironmentsLastActivityQuery = (
  ...args: Parameters<typeof getEnvironmentsLastActivity>
) =>
  queryOptions({
    queryKey: ["runs", "getEnvironmentsLastActivity", args],
    queryFn: () => getEnvironmentsLastActivity(...args),
  });

export async function getActiveRuns() {
  return parseResponse(routes["get-active-runs"].$get());
}

export const getActiveRunsQuery = (...args: Parameters<typeof getActiveRuns>) =>
  queryOptions({
    queryKey: ["runs", "getActiveRuns", args],
    queryFn: () => getActiveRuns(...args),
  });

export async function getEnvironmentRuns(environmentId: string) {
  return parseResponse(
    routes["get-environment-runs"].$get({ query: { environmentId } })
  );
}

export const getEnvironmentRunsQuery = (
  ...args: Parameters<typeof getEnvironmentRuns>
) =>
  queryOptions({
    queryKey: ["runs", "getEnvironmentRuns", args],
    queryFn: () => getEnvironmentRuns(...args),
  });

export async function getRunSnapshot(runId: string) {
  return parseResponse(routes["get-run-snapshot"].$get({ query: { runId } }));
}

export const getRunSnapshotQuery = (
  ...args: Parameters<typeof getRunSnapshot>
) =>
  queryOptions({
    queryKey: ["runs", "getRunSnapshot", args],
    queryFn: () => getRunSnapshot(...args),
  });

export async function getEnvironmentKpis(environmentId: string) {
  return parseResponse(
    routes["get-environment-kpis"].$get({ query: { environmentId } })
  );
}

export const getEnvironmentKpisQuery = (
  ...args: Parameters<typeof getEnvironmentKpis>
) =>
  queryOptions({
    queryKey: ["runs", "getEnvironmentKpis", args],
    queryFn: () => getEnvironmentKpis(...args),
  });

export type ActiveRun = Awaited<ReturnType<typeof getActiveRuns>>[number];
export type EnvironmentActivity = Awaited<
  ReturnType<typeof getEnvironmentsLastActivity>
>[string];
