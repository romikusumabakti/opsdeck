import { z } from "zod";
import { sessionRouter } from "@/server/router";
import { listActivity } from "@/server/services/activity";
import { query } from "@/server/validation";

export const activityRouter = sessionRouter().get(
  "/list-activity",
  // The service takes any limit; cap it so one request can't ask for the
  // whole log. Absent keeps the service default (the page's 100).
  query(
    z.object({ limit: z.coerce.number().int().min(1).max(500).optional() })
  ),
  async (c) => c.json(await listActivity(c.req.valid("query").limit))
);
