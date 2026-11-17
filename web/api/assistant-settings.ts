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

export async function getAssistantUsage() {
  return parseResponse(routes.usage.$get({ query: {} }));
}

export const getAssistantUsageQuery = () =>
  queryOptions({
    queryKey: ["assistant-settings", "getAssistantUsage"],
    queryFn: getAssistantUsage,
  });

export async function saveAssistantSettings(
  input: Parameters<typeof routes.$put>[0]["json"]
) {
  return orFailure(
    () => parseResponse(routes.$put({ json: input })),
    (message) => ({ success: false, message }) as const
  );
}

const postConnectionTest = () =>
  parseResponse(routes.test.$post({}, NO_REFETCH));

/** Per-capability result; `error` is the class of a failure. */
export type ConnectionTest = Awaited<ReturnType<typeof postConnectionTest>>;

/** The result, or the refusal (e.g. settings incomplete) as `{ message }`. */
export async function testAssistantConnection() {
  return orFailure<ConnectionTest | { success: false; message: string }>(
    postConnectionTest,
    (message) => ({ success: false, message })
  );
}

export type AssistantSettings = Awaited<
  ReturnType<typeof getAssistantSettings>
>;

export type AssistantUsage = Awaited<ReturnType<typeof getAssistantUsage>>;
