import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, NO_REFETCH, orFailure } from "@/web/api/client";

const routes = api.api["assistant-settings"];

export async function getAssistantSettings() {
  return parseResponse(routes.$get());
}

export const getAssistantSettingsQuery = () =>
  queryOptions({
    queryKey: ["assistant-settings", "getAssistantSettings"],
    queryFn: getAssistantSettings,
  });

export async function saveAssistantSettings(
  input: Parameters<typeof routes.$put>[0]["json"]
) {
  return orFailure(
    () => parseResponse(routes.$put({ json: input })),
    (message) => ({ success: false, message }) as const
  );
}

export async function testAssistantConnection() {
  return orFailure(
    () => parseResponse(routes.test.$post({}, NO_REFETCH)),
    (message) => ({ success: false, message }) as const
  );
}

export type AssistantSettings = Awaited<
  ReturnType<typeof getAssistantSettings>
>;
