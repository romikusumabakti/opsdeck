import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  acknowledgeInstanceBackup,
  getInstanceBackups,
  instanceBackupSettingsSchema,
  requestInstanceBackup,
  requestInstanceRestore,
  requireInstanceManage,
  restoreConfirmSchema,
  saveInstanceBackupSettings,
  verifyKeySchema,
  verifySecretsKey,
} from "@/server/services/instance-backups";
import {
  applyInstanceUpdate,
  applyUpdateSchema,
  getInstanceUpdates,
  restoreSafetyBackup,
  saveInstanceUpdateSettings,
  updateSettingsSchema,
} from "@/server/services/instance-updates";
import {
  getAuthorizedKeysLine,
  getInstanceSshKey,
  requestMoveAll,
  requestRotate,
} from "@/server/services/server-key-jobs";
import { json, param, query } from "@/server/validation";

const idParam = param(z.object({ id: uuidSchema }));

/**
 * The instance SSH key (Admin → Instance → SSH key): org server:manage, which
 * the services check, not instance:manage. Mounted before instanceRouter, so
 * its instance:manage guard never runs for these paths.
 */
export const instanceSshKeyRouter = sessionRouter()
  .get("/", async (c) => c.json(await getInstanceSshKey()))
  // The line a new server's admin installs by hand, restricted to `from`.
  .get(
    "/authorized-line",
    query(z.object({ from: z.string().trim().min(1).max(64) })),
    async (c) => c.json(await getAuthorizedKeysLine(c.req.valid("query").from))
  )
  .post("/move-all", async (c) => c.json(await requestMoveAll(), 202))
  .post("/rotate", async (c) => c.json(await requestRotate(), 202));

/**
 * The Panel instance itself (Admin → Instance). The router checks org
 * instance:manage first; each service function checks it again.
 */
export const instanceRouter = sessionRouter()
  // Before any validator, so a non-admin always gets 403 `forbidden` and
  // never learns the payload shape from a 400.
  .use(async (_c, next) => {
    await requireInstanceManage();
    await next();
  })
  .get("/backups", async (c) => c.json(await getInstanceBackups()))
  .put("/backups/settings", json(instanceBackupSettingsSchema), async (c) =>
    c.json(await saveInstanceBackupSettings(c.req.valid("json")))
  )
  .post("/backups/run", async (c) => c.json(await requestInstanceBackup(), 202))
  .post("/backups/verify-key", json(verifyKeySchema), async (c) =>
    c.json(await verifySecretsKey(c.req.valid("json").key))
  )
  .post("/backups/:id/acknowledge", idParam, async (c) =>
    c.json(await acknowledgeInstanceBackup(c.req.valid("param").id))
  )
  .post(
    "/backups/:id/restore",
    idParam,
    json(restoreConfirmSchema),
    async (c) =>
      c.json(
        await requestInstanceRestore(
          c.req.valid("param").id,
          c.req.valid("json").confirm
        ),
        202
      )
  )
  .get("/updates", async (c) => c.json(await getInstanceUpdates()))
  .put("/updates/settings", json(updateSettingsSchema), async (c) =>
    c.json(await saveInstanceUpdateSettings(c.req.valid("json")))
  )
  .post("/updates/apply", json(applyUpdateSchema), async (c) =>
    c.json(await applyInstanceUpdate(c.req.valid("json").version), 202)
  )
  .post(
    "/updates/restore-safety-backup",
    json(restoreConfirmSchema),
    async (c) =>
      c.json(await restoreSafetyBackup(c.req.valid("json").confirm), 202)
  );
