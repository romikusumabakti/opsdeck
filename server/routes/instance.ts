import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { RASTER_LOGO_MAX_BYTES } from "@/lib/brand-logo-validate";
import { backupDestinationInputSchema, uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  clearBackupDestination,
  getBackupDestination,
  saveBackupDestination,
  testBackupDestination,
} from "@/server/services/backup-destination";
import {
  brandingInputSchema,
  brandThemeSchema,
  getBrandingSettings,
  removeBrandLogo,
  saveBranding,
  saveBrandLogo,
} from "@/server/services/branding";
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

/** The largest logo file (the raster limit; SVG's is lower, checked later). */
const BRAND_LOGO_MAX_BYTES = RASTER_LOGO_MAX_BYTES;
// The whole multipart body is capped before it is parsed, with room for the
// part headers, so a huge upload is a 413 without being buffered whole.
const brandLogoBodyLimit = bodyLimit({
  maxSize: BRAND_LOGO_MAX_BYTES + 16 * 1024,
  onError: (c) => c.json({ error: "too_large" }, 413),
});

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
  // Branding (Admin › Instance › Branding).
  .get("/branding", async (c) => c.json(await getBrandingSettings()))
  .put("/branding", json(brandingInputSchema), async (c) =>
    c.json(await saveBranding(c.req.valid("json")))
  )
  .put(
    "/branding/logo",
    query(brandThemeSchema),
    brandLogoBodyLimit,
    async (c) => {
      const form = await c.req.raw.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return c.json({ error: "no_file" }, 400);
      // Before decoding: the part size alone settles the raster limit.
      if (file.size > BRAND_LOGO_MAX_BYTES) {
        return c.json({ error: "too_large" }, 413);
      }
      const result = await saveBrandLogo(
        c.req.valid("query").theme,
        new Uint8Array(await file.arrayBuffer())
      );
      if ("error" in result) {
        const status =
          result.error === "too_large"
            ? 413
            : result.error === "unsupported_type"
              ? 415
              : 422;
        return c.json({ error: result.error }, status);
      }
      return c.json(result);
    }
  )
  .delete("/branding/logo", query(brandThemeSchema), async (c) =>
    c.json(await removeBrandLogo(c.req.valid("query").theme))
  )
  .get("/backups", async (c) => c.json(await getInstanceBackups()))
  .put("/backups/settings", json(instanceBackupSettingsSchema), async (c) =>
    c.json(await saveInstanceBackupSettings(c.req.valid("json")))
  )
  // The backup destination (its own S3 credentials; the secret never comes
  // back, only `secretSet`).
  .get("/backups/destination", async (c) =>
    c.json(await getBackupDestination())
  )
  .put("/backups/destination", json(backupDestinationInputSchema), async (c) =>
    c.json(await saveBackupDestination(c.req.valid("json")))
  )
  .delete("/backups/destination", async (c) =>
    c.json(await clearBackupDestination())
  )
  .post(
    "/backups/destination/test",
    json(backupDestinationInputSchema),
    async (c) => c.json(await testBackupDestination(c.req.valid("json")))
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
  .post("/updates/check", async (c) =>
    c.json(await getInstanceUpdates({ force: true }))
  )
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
