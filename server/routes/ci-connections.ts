import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  listCiConnections,
  refreshExtensionKey,
  updateCiConnection,
  updateCiConnectionSchema,
} from "@/server/services/ci-connections";
import { json, param } from "@/server/validation";

const idParam = param(z.object({ id: uuidSchema }));

/**
 * CI server connections. Each service function states its own permission
 * (org integration:manage here), because routes added later answer to a
 * different one.
 */
export const ciConnectionsRouter = sessionRouter()
  .get("/", async (c) => c.json(await listCiConnections()))
  .patch("/:id", idParam, json(updateCiConnectionSchema), async (c) =>
    c.json(
      await updateCiConnection(c.req.valid("param").id, c.req.valid("json"))
    )
  )
  .post("/:id/refresh-key", idParam, async (c) =>
    c.json(await refreshExtensionKey(c.req.valid("param").id))
  );
