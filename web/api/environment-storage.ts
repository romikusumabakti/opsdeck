import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

// An environment's storage connections (server/routes/environment-storage).
// Refusals reject with an ApiError; a bad key prefix carries the code
// `s3KeyPrefixInvalid`.
const routes = api.api.environments[":id"].storage;
const one = routes[":connectionId"];

type CreateBody = Parameters<typeof routes.$post>[0]["json"];
type UpdateBody = Parameters<typeof one.$patch>[0]["json"];
type TestBody = Parameters<(typeof routes.test)["$post"]>[0]["json"];

async function listEnvironmentStorage(environmentId: string) {
  return parseResponse(routes.$get({ param: { id: environmentId } }));
}

export const environmentStorageQuery = (environmentId: string) =>
  queryOptions({
    queryKey: ["environment-storage", environmentId],
    queryFn: () => listEnvironmentStorage(environmentId),
  });

async function getEnvironmentStorage(
  environmentId: string,
  connectionId: string
) {
  return parseResponse(
    one.$get({ param: { id: environmentId, connectionId } })
  );
}

export const environmentStorageConnectionQuery = (
  environmentId: string,
  connectionId: string
) =>
  queryOptions({
    queryKey: ["environment-storage", environmentId, connectionId],
    queryFn: () => getEnvironmentStorage(environmentId, connectionId),
  });

export async function createEnvironmentStorage(
  environmentId: string,
  body: CreateBody
) {
  return parseResponse(
    routes.$post({ param: { id: environmentId }, json: body })
  );
}

export async function updateEnvironmentStorage(
  environmentId: string,
  connectionId: string,
  body: UpdateBody
) {
  return parseResponse(
    one.$patch({ param: { id: environmentId, connectionId }, json: body })
  );
}

export async function deleteEnvironmentStorage(
  environmentId: string,
  connectionId: string
) {
  return parseResponse(
    one.$delete({ param: { id: environmentId, connectionId } })
  );
}

export async function testEnvironmentStorage(
  environmentId: string,
  body: TestBody
) {
  return parseResponse(
    routes.test.$post({ param: { id: environmentId }, json: body })
  );
}

export type EnvironmentStorageRow = Awaited<
  ReturnType<typeof listEnvironmentStorage>
>[number];
