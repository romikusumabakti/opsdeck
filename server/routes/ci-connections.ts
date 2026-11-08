import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  listRegistrableRepos,
  listRegistrationConnections,
} from "@/server/services/apps";
import {
  listCiConnections,
  updateCiConnection,
  updateCiConnectionSchema,
} from "@/server/services/ci-connections";
import { json, param } from "@/server/validation";

const idParam = param(z.object({ id: uuidSchema }));

/**
 * CI server connections. Each service function states its own permission:
 * org integration:manage for the admin routes, app registrants (admins and
 * project engineers) for `/options` and `/:id/repos`.
 */
export const ciConnectionsRouter = sessionRouter()
  .get("/", async (c) => c.json(await listCiConnections()))
  .get("/options", async (c) => c.json(await listRegistrationConnections()))
  .get("/:id/repos", idParam, async (c) =>
    c.json(await listRegistrableRepos(c.req.valid("param").id))
  )
  .patch("/:id", idParam, json(updateCiConnectionSchema), async (c) =>
    c.json(
      await updateCiConnection(c.req.valid("param").id, c.req.valid("json"))
    )
  );
