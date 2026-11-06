import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  createDatabaseHost,
  databaseHostInputSchema,
  deleteDatabaseHost,
  listDatabaseHosts,
} from "@/server/services/database-hosts";
import { json, param, query } from "@/server/validation";

// Registered database hosts; the service checks org server:manage.
export const databaseHostsRouter = sessionRouter()
  .get("/", query(z.object({ serverId: uuidSchema.optional() })), async (c) =>
    c.json(await listDatabaseHosts(c.req.valid("query").serverId))
  )
  .post("/", json(databaseHostInputSchema), async (c) =>
    c.json(await createDatabaseHost(c.req.valid("json")))
  )
  .delete("/:id", param(z.object({ id: uuidSchema })), async (c) => {
    await deleteDatabaseHost(c.req.valid("param").id);
    return c.json({ ok: true });
  });
