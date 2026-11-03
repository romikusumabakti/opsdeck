import { z } from "zod";
import { deployTagSchema } from "@/lib/deploy/validation";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  createDeployTarget,
  createTargetSchema,
  deleteDeployTarget,
  deployTag,
  listDeployTargets,
  rollbackTarget,
  updateDeployTarget,
  updateTargetSchema,
} from "@/server/services/deploys";
import { json, param, query } from "@/server/validation";

/**
 * Panel deploys: targets, manual deploys and rollbacks. Viewing needs any
 * project role; deploy, rollback and configuring need the maintainer role
 * (the service functions check it against the target's environment).
 */
export const deploysRouter = sessionRouter()
  .get("/targets", query(z.object({ environmentId: uuidSchema })), async (c) =>
    c.json(await listDeployTargets(c.req.valid("query").environmentId))
  )
  .post("/targets", json(createTargetSchema), async (c) =>
    c.json(await createDeployTarget(c.req.valid("json")))
  )
  .patch(
    "/targets/:id",
    param(z.object({ id: uuidSchema })),
    json(updateTargetSchema),
    async (c) =>
      c.json(
        await updateDeployTarget(c.req.valid("param").id, c.req.valid("json"))
      )
  )
  .delete("/targets/:id", param(z.object({ id: uuidSchema })), async (c) => {
    await deleteDeployTarget(c.req.valid("param").id);
    return c.json({ ok: true });
  })
  .post(
    "/deploy",
    json(z.object({ targetId: uuidSchema, tag: deployTagSchema })),
    async (c) => {
      const { targetId, tag } = c.req.valid("json");
      return c.json(await deployTag(targetId, tag));
    }
  )
  .post("/rollback", json(z.object({ targetId: uuidSchema })), async (c) =>
    c.json(await rollbackTarget(c.req.valid("json").targetId))
  );
