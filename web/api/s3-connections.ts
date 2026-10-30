import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api["s3-connections"];
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function getS3Connections() {
  return parseResponse(routes["get-s3-connections"].$get());
}

export const getS3ConnectionsQuery = (
  ...args: Parameters<typeof getS3Connections>
) =>
  queryOptions({
    queryKey: ["s3-connections", "getS3Connections", args],
    queryFn: () => getS3Connections(...args),
  });

export async function getS3Connection(id: string) {
  return parseResponse(routes["get-s3-connection"].$get({ query: { id } }));
}

export const getS3ConnectionQuery = (
  ...args: Parameters<typeof getS3Connection>
) =>
  queryOptions({
    queryKey: ["s3-connections", "getS3Connection", args],
    queryFn: () => getS3Connection(...args),
  });

export async function createS3Connection(
  data: Body<"create-s3-connection">["data"]
) {
  return orFailure(
    () =>
      parseResponse(routes["create-s3-connection"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function updateS3Connection(
  id: Body<"update-s3-connection">["id"],
  data: Body<"update-s3-connection">["data"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["update-s3-connection"].$post({ json: { id, data } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteS3Connection(
  id: Body<"delete-s3-connection">["id"]
) {
  return orFailure(
    () => parseResponse(routes["delete-s3-connection"].$post({ json: { id } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function testS3ConnectionAction(
  input: Body<"test-s3-connection-action">["input"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["test-s3-connection-action"].$post({ json: { input } })
      ),
    (message) => ({ ok: false, message }) as const
  );
}
