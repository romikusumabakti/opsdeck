import { z } from "zod";
import {
  cloudflareZoneInputSchema,
  cloudflareZoneUpdateSchema,
  tunnelInputSchema,
  tunnelUpdateSchema,
  uuidSchema,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  attachTunnelNetwork,
  createCloudflareZone,
  createTunnel,
  createTunnelRoute,
  deleteCloudflareZone,
  deleteTunnel,
  deleteTunnelRoute,
  getCloudflareZones,
  getOriginCandidates,
  getTunnel,
  getTunnelRoutes,
  getTunnels,
  testCloudflareZone,
  updateCloudflareZone,
  updateTunnel,
} from "@/server/services/tunnels";
import { json, query } from "@/server/validation";

const idQuery = query(z.object({ id: uuidSchema }));

export const tunnelsRouter = sessionRouter()
  .get("/get-cloudflare-zones", async (c) => c.json(await getCloudflareZones()))
  .get("/get-tunnels", async (c) => c.json(await getTunnels()))
  .get("/get-tunnel", idQuery, async (c) =>
    c.json(await getTunnel(c.req.valid("query").id))
  )
  // Both read the tunnel host over SSH (its config.yml, and the Docker
  // networks and containers it can reach), so they are slow.
  .get("/get-tunnel-routes", idQuery, async (c) =>
    c.json(await getTunnelRoutes(c.req.valid("query").id))
  )
  .get("/get-origin-candidates", idQuery, async (c) =>
    c.json(await getOriginCandidates(c.req.valid("query").id))
  )
  .post(
    "/create-cloudflare-zone",
    json(z.object({ data: cloudflareZoneInputSchema })),
    async (c) => c.json(await createCloudflareZone(c.req.valid("json").data))
  )
  .post(
    "/update-cloudflare-zone",
    json(z.object({ id: uuidSchema, data: cloudflareZoneUpdateSchema })),
    async (c) => {
      const { id, data } = c.req.valid("json");
      return c.json(await updateCloudflareZone(id, data));
    }
  )
  .post(
    "/delete-cloudflare-zone",
    json(z.object({ id: uuidSchema })),
    async (c) => c.json(await deleteCloudflareZone(c.req.valid("json").id))
  )
  .post(
    "/test-cloudflare-zone",
    // A probe of unsaved form values: Cloudflare's answer is the message.
    json(
      z.object({
        input: z.object({
          zoneId: z.string().max(64),
          apiToken: z.string().max(1024).optional(),
          id: uuidSchema.optional(),
        }),
      })
    ),
    async (c) => c.json(await testCloudflareZone(c.req.valid("json").input))
  )
  .post(
    "/create-tunnel",
    json(z.object({ data: tunnelInputSchema })),
    async (c) => c.json(await createTunnel(c.req.valid("json").data))
  )
  .post(
    "/update-tunnel",
    json(z.object({ id: uuidSchema, data: tunnelUpdateSchema })),
    async (c) => {
      const { id, data } = c.req.valid("json");
      return c.json(await updateTunnel(id, data));
    }
  )
  .post("/delete-tunnel", json(z.object({ id: uuidSchema })), async (c) =>
    c.json(await deleteTunnel(c.req.valid("json").id))
  )
  .post(
    "/create-tunnel-route",
    // The service answers a bad label or origin with the schema's own message
    // (the route form shows it), so the fields are only bounded here.
    json(
      z.object({
        input: z.object({
          tunnelId: uuidSchema,
          label: z.string().max(253),
          originHost: z.string().max(255),
          originPort: z.number(),
        }),
      })
    ),
    async (c) => c.json(await createTunnelRoute(c.req.valid("json").input))
  )
  .post(
    "/delete-tunnel-route",
    json(
      z.object({
        input: z.object({
          tunnelId: uuidSchema,
          hostname: z.string().max(253),
        }),
      })
    ),
    async (c) => c.json(await deleteTunnelRoute(c.req.valid("json").input))
  )
  .post(
    "/attach-tunnel-network",
    json(
      z.object({
        input: z.object({
          tunnelId: uuidSchema,
          network: z.string().trim().min(1).max(255),
        }),
      })
    ),
    async (c) => c.json(await attachTunnelNetwork(c.req.valid("json").input))
  );
