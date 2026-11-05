import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  forceUnlockEnvironment,
  getDeployLockState,
  lockEnvironment,
  unlockEnvironment,
} from "@/server/services/deploy-locks";
import { json, param } from "@/server/validation";

const envParam = param(z.object({ id: uuidSchema }));

// Loosely bounded here: the service validates reason and expiry itself so the
// caller gets a translated message rather than the generic 400.
const reasonField = z.string().max(2000).optional();

/**
 * An environment's deploy lock, mounted at /api/environments. The service
 * functions check who may read, lock, unlock and force-unlock.
 */
export const deployLocksRouter = sessionRouter()
  .get("/:id/deploy-lock", envParam, async (c) =>
    c.json(await getDeployLockState(c.req.valid("param").id))
  )
  .put(
    "/:id/deploy-lock",
    envParam,
    json(
      z.object({
        reason: reasonField,
        expiresAt: z.string().max(64).optional(),
      })
    ),
    async (c) =>
      c.json(
        await lockEnvironment(c.req.valid("param").id, c.req.valid("json"))
      )
  )
  .delete("/:id/deploy-lock", envParam, async (c) =>
    c.json(await unlockEnvironment(c.req.valid("param").id))
  )
  .post(
    "/:id/deploy-lock/force-unlock",
    envParam,
    json(z.object({ reason: reasonField })),
    async (c) =>
      c.json(
        await forceUnlockEnvironment(
          c.req.valid("param").id,
          c.req.valid("json")
        )
      )
  );
