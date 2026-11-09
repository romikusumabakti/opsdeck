import { z } from "zod";
import {
  serverInputSchema,
  serverUpdateSchema,
  uuidSchema,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  getServerPreflight,
  runServerPreflight,
  suggestEntryPort,
} from "@/server/services/preflight";
import {
  moveToKeyAction,
  reinstallKeyAction,
  trustHostKeyAction,
} from "@/server/services/server-keys";
import {
  bulkDeleteServers,
  createServer,
  deleteServer,
  getServerById,
  getServers,
  getServerUsage,
  serverView,
  testServerConnection,
  updateServer,
} from "@/server/services/servers";
import { json, param, query } from "@/server/validation";

// The services return whole rows, encrypted SSH password and host key blobs
// included; serverView keeps the password and the blobs on the server (edit
// forms send a new password or none).

// Bulk delete acts on what the servers table shows; the cap keeps a crafted
// request from naming the whole table.
const idParam = param(z.object({ id: uuidSchema }));

const serverIds = z.array(uuidSchema).max(500);

export const serversRouter = sessionRouter()
  .get("/get-servers", async (c) =>
    c.json((await getServers()).map(serverView))
  )
  .get("/get-server-by-id", query(z.object({ id: uuidSchema })), async (c) => {
    const server = await getServerById(c.req.valid("query").id);
    return c.json(server ? serverView(server) : null);
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
        result.success ? { ...result, data: serverView(result.data) } : result
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
          auth: z.literal("key").optional(),
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
  )
  // Preflight scan and entry-port suggestion; the services check server:manage.
  .post("/:id/preflight", idParam, async (c) =>
    c.json(await runServerPreflight(c.req.valid("param").id))
  )
  .get("/:id/preflight", idParam, async (c) =>
    c.json(await getServerPreflight(c.req.valid("param").id))
  )
  .get("/:id/free-port", idParam, async (c) =>
    c.json(await suggestEntryPort(c.req.valid("param").id))
  )
  // Moving to the instance SSH key; the services check server:manage. The
  // reinstall password signs in once and is never stored.
  .post("/:id/move-to-key", idParam, async (c) =>
    c.json(await moveToKeyAction(c.req.valid("param").id))
  )
  .post(
    "/:id/reinstall-key",
    idParam,
    json(z.object({ password: z.string().min(1).max(1024) })),
    async (c) =>
      c.json(
        await reinstallKeyAction(
          c.req.valid("param").id,
          c.req.valid("json").password
        )
      )
  )
  .post(
    "/:id/trust-host-key",
    idParam,
    json(z.object({ expectedFingerprint: z.string().min(1).max(100) })),
    async (c) =>
      c.json(
        await trustHostKeyAction(
          c.req.valid("param").id,
          c.req.valid("json").expectedFingerprint
        )
      )
  );
