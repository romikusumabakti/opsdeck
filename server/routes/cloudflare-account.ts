import { sessionRouter } from "@/server/router";
import {
  cloudflareAccountInputSchema,
  getCloudflareAccount,
  listCloudflareAccessPolicies,
  listCloudflareIdentityProviders,
  listCloudflareTunnels,
  saveCloudflareAccount,
  verifyCloudflareAccount,
} from "@/server/services/cloudflare-account";
import { json } from "@/server/validation";

/** The Cloudflare account record. Each service function checks server:manage. */
export const cloudflareAccountRouter = sessionRouter()
  .get("/", async (c) => c.json(await getCloudflareAccount()))
  .put("/", json(cloudflareAccountInputSchema), async (c) =>
    c.json(await saveCloudflareAccount(c.req.valid("json")))
  )
  .post("/verify", async (c) => c.json(await verifyCloudflareAccount()))
  .get("/tunnels", async (c) => c.json(await listCloudflareTunnels()))
  .get("/access-policies", async (c) =>
    c.json(await listCloudflareAccessPolicies())
  )
  .get("/identity-providers", async (c) =>
    c.json(await listCloudflareIdentityProviders())
  );
