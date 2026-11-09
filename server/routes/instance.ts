import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  acknowledgeInstanceBackup,
  getInstanceBackups,
  instanceBackupSettingsSchema,
  requestInstanceBackup,
  saveInstanceBackupSettings,
  verifyKeySchema,
  verifySecretsKey,
} from "@/server/services/instance-backups";
import { json, param } from "@/server/validation";

const idParam = param(z.object({ id: uuidSchema }));

/**
 * The Panel instance itself (Admin → Instance). Each service function checks
 * org instance:manage.
 */
export const instanceRouter = sessionRouter()
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
  );
