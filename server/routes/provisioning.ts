import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  getProvisioning,
  startProvisioning,
} from "@/server/services/provisioning";
import { param } from "@/server/validation";

const envParam = param(z.object({ id: uuidSchema }));

/** An environment's provisioning plan and run, mounted at /api/environments. */
export const provisioningRouter = sessionRouter()
  .get("/:id/provisioning", envParam, async (c) =>
    c.json(await getProvisioning(c.req.valid("param").id))
  )
  .post("/:id/provisioning", envParam, async (c) =>
    c.json(await startProvisioning(c.req.valid("param").id))
  );
