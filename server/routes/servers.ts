import { z } from "zod";
import type { SafeServer, Server } from "@/lib/db/schema";
import {
  serverInputSchema,
  serverUpdateSchema,
  uuidSchema,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  bulkDeleteServers,
  createServer,
  deleteServer,
  getServerById,
  getServers,
  getServerUsage,
  testServerConnection,
  updateServer,
} from "@/server/services/servers";
import { json, query } from "@/server/validation";

// The services return whole rows, encrypted SSH password included; under Next
// the pages projected it away before rendering. No client form reads it (edit
// forms send a new password or none), so it never leaves the server.
function toSafe({ password: _password, ...rest }: Server): SafeServer {
  return rest;
}

// Bulk delete acts on what the servers table shows; the cap keeps a crafted
// request from naming the whole table.
const serverIds = z.array(uuidSchema).max(500);

export const serversRouter = sessionRouter()
  .get("/get-servers", async (c) => c.json((await getServers()).map(toSafe)))
  .get("/get-server-by-id", query(z.object({ id: uuidSchema })), async (c) => {
    const server = await getServerById(c.req.valid("query").id);
    return c.json(server ? toSafe(server) : null);
  })
  .get(
    "/get-server-usage",
    query(z.object({ serverId: uuidSchema })),
    async (c) => c.json(await getServerUsage(c.req.valid("query").serverId))
  )
  .post(
    "/create-server",
    json(z.object({ data: serverInputSchema })),
    async (c) => {
      const result = await createServer(c.req.valid("json").data);
      return c.json(
        result.success ? { ...result, data: toSafe(result.data) } : result
      );
    }
  )
  .post(
    "/update-server",
    json(z.object({ id: uuidSchema, data: serverUpdateSchema })),
    async (c) => {
      const { id, data } = c.req.valid("json");
      return c.json(await updateServer(id, data));
    }
  )
  .post(
    "/test-server-connection",
    // Empty host/username come back as the service's translated message.
    json(
      z.object({
        input: z.object({
          host: z.string().max(255),
          username: z.string().max(255),
          password: z.string().max(1024).optional(),
          serverId: uuidSchema.optional(),
        }),
      })
    ),
    async (c) => c.json(await testServerConnection(c.req.valid("json").input))
  )
  .post("/bulk-delete-servers", json(z.object({ ids: serverIds })), async (c) =>
    c.json(await bulkDeleteServers(c.req.valid("json").ids))
  )
  .post("/delete-server", json(z.object({ id: uuidSchema })), async (c) =>
    c.json(await deleteServer(c.req.valid("json").id))
  );
