import { sessionRouter } from "@/server/router";
import { listAllApps } from "@/server/services/apps";

/**
 * The legacy apps list, for every signed-in user who works with projects. Kept
 * only while screens still group services by app; registration and every
 * per-service action moved to /api/service-catalog.
 */
export const appsRouter = sessionRouter().get("/", async (c) =>
  c.json(await listAllApps())
);
