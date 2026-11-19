import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  assignS3Connection,
  deleteUnassignedS3Connection,
  getS3ConnectionLocation,
  listUnassignedS3Connections,
} from "@/server/services/s3-connections";
import { json, query } from "@/server/validation";

// Where an old /storage/<id> link leads, and the admin handling of
// unassigned connections (Admin › Storage). The service takes the caller's
// rights for each: viewing the connection's environment for its location,
// the org role's own storage:manage for the rest. Connections are created,
// edited and probed only as an environment's storage (environment-storage).
export const s3ConnectionsRouter = sessionRouter()
  .get(
    "/get-s3-connection-location",
    query(z.object({ id: uuidSchema })),
    async (c) => c.json(await getS3ConnectionLocation(c.req.valid("query").id))
  )
  .get("/list-unassigned-s3-connections", async (c) =>
    c.json(await listUnassignedS3Connections())
  )
  .post(
    "/assign-s3-connection",
    json(z.object({ id: uuidSchema, environmentId: uuidSchema })),
    async (c) => {
      const { id, environmentId } = c.req.valid("json");
      return c.json(await assignS3Connection(id, environmentId));
    }
  )
  .post(
    "/delete-unassigned-s3-connection",
    json(z.object({ id: uuidSchema })),
    async (c) => {
      await deleteUnassignedS3Connection(c.req.valid("json").id);
      return c.json({ ok: true });
    }
  );
