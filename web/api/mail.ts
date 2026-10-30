import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";
import { REMOTE_PROBE } from "@/web/query-client";

const routes = api.api.mail;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listMail(
  environmentId: string,
  input: { query?: string; start?: number }
) {
  return orFailure(
    () =>
      parseResponse(
        routes["list-mail"].$get({
          query: { q: JSON.stringify({ environmentId, input }) },
        })
      ),
    (message) => ({ success: false, error: message }) as const
  );
}

export const listMailQuery = (...args: Parameters<typeof listMail>) =>
  queryOptions({
    queryKey: ["mail", "listMail", args],
    queryFn: () => listMail(...args),
    ...REMOTE_PROBE,
  });

export async function getMail(environmentId: string, messageId: string) {
  return orFailure(
    () =>
      parseResponse(
        routes["get-mail"].$get({ query: { environmentId, messageId } })
      ),
    (message) => ({ success: false, error: message }) as const
  );
}

export const getMailQuery = (...args: Parameters<typeof getMail>) =>
  queryOptions({
    queryKey: ["mail", "getMail", args],
    queryFn: () => getMail(...args),
    ...REMOTE_PROBE,
  });

export async function getMailSource(environmentId: string, messageId: string) {
  return orFailure(
    () =>
      parseResponse(
        routes["get-mail-source"].$get({ query: { environmentId, messageId } })
      ),
    (message) => ({ success: false, error: message }) as const
  );
}

export const getMailSourceQuery = (...args: Parameters<typeof getMailSource>) =>
  queryOptions({
    queryKey: ["mail", "getMailSource", args],
    queryFn: () => getMailSource(...args),
    ...REMOTE_PROBE,
  });

export async function deleteMail(
  environmentId: Body<"delete-mail">["environmentId"],
  target: Body<"delete-mail">["target"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["delete-mail"].$post({ json: { environmentId, target } })
      ),
    (message) => ({ success: false, error: message }) as const
  );
}

/** Page data: whether the environment has Mailpit configured. */
export async function getMailConfigured(environmentId: string) {
  return parseResponse(routes.configured.$get({ query: { environmentId } }));
}

export const getMailConfiguredQuery = (
  ...args: Parameters<typeof getMailConfigured>
) =>
  queryOptions({
    queryKey: ["mail", "getMailConfigured", args],
    queryFn: () => getMailConfigured(...args),
  });

export type MailResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; notFound?: boolean };
export type MailDetail = Extract<
  Awaited<ReturnType<typeof getMail>>,
  { success: true }
>["data"];
