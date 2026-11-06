import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  deleteRemoteTunnel,
  listRemoteTunnels,
  registerRemoteTunnel,
  remoteTunnelInputSchema,
} from "@/server/services/remote-tunnels";
import { json, param } from "@/server/validation";

/** Registered remote tunnels. Each service function checks server:manage. */
export const remoteTunnelsRouter = sessionRouter()
  .get("/", async (c) => c.json(await listRemoteTunnels()))
  .post("/", json(remoteTunnelInputSchema), async (c) =>
    c.json(await registerRemoteTunnel(c.req.valid("json")), 201)
  )
  .delete("/:id", param(z.object({ id: uuidSchema })), async (c) => {
    await deleteRemoteTunnel(c.req.valid("param").id);
    return c.json({ ok: true });
  });
