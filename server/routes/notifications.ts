import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  getUnreadNotificationCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/server/services/notifications";
import { json } from "@/server/validation";

export const notificationsRouter = sessionRouter()
  .get("/list-notifications", async (c) => c.json(await listNotifications()))
  .get("/get-unread-notification-count", async (c) =>
    c.json(await getUnreadNotificationCount())
  )
  .post(
    "/mark-notification-read",
    json(z.object({ id: uuidSchema })),
    async (c) => c.json(await markNotificationRead(c.req.valid("json").id))
  )
  .post("/mark-all-notifications-read", async (c) =>
    c.json(await markAllNotificationsRead())
  );
