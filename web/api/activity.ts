import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

const routes = api.api.activity;

export async function listActivity(limit?: number) {
  return parseResponse(
    routes["list-activity"].$get({
      query: { limit: limit === undefined ? undefined : String(limit) },
    })
  );
}

export const listActivityQuery = (...args: Parameters<typeof listActivity>) =>
  queryOptions({
    queryKey: ["activity", "listActivity", args],
    queryFn: () => listActivity(...args),
  });
