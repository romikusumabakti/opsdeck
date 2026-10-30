import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api.notifications;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listNotifications() {
  return parseResponse(routes["list-notifications"].$get());
}

export const listNotificationsQuery = (
  ...args: Parameters<typeof listNotifications>
) =>
  queryOptions({
    queryKey: ["notifications", "listNotifications", args],
    queryFn: () => listNotifications(...args),
  });

export async function getUnreadNotificationCount() {
  return parseResponse(routes["get-unread-notification-count"].$get());
}

export const getUnreadNotificationCountQuery = (
  ...args: Parameters<typeof getUnreadNotificationCount>
) =>
  queryOptions({
    queryKey: ["notifications", "getUnreadNotificationCount", args],
    queryFn: () => getUnreadNotificationCount(...args),
  });

export async function markNotificationRead(
  id: Body<"mark-notification-read">["id"]
) {
  return orFailure(
    () =>
      parseResponse(routes["mark-notification-read"].$post({ json: { id } })),
    () => ({ success: false }) as const
  );
}

export async function markAllNotificationsRead() {
  return orFailure(
    () => parseResponse(routes["mark-all-notifications-read"].$post()),
    () => ({ success: false }) as const
  );
}

export type Notification = Awaited<
  ReturnType<typeof listNotifications>
>[number];
