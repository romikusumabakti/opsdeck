import { z } from "zod";
import { backupFilenameSchema, uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  createDatabaseBackup,
  getBackupList,
  restoreDatabaseBackup,
} from "@/server/services/backups";
import { json, query } from "@/server/validation";

// A target database other than the environment's configured one is validated
// by the service (databaseNameSchema), which lets the configured name through
// unchecked — so the router only bounds it.
const targetDatabase = z.string().max(255).optional();

export const backupsRouter = sessionRouter()
  // A synchronous SSH probe of the backup directory: slow, so the client caches
  // it (staleTime 30s) rather than refetching on every navigation.
  .get(
    "/get-backup-list",
    query(z.object({ environmentId: uuidSchema })),
    async (c) => c.json(await getBackupList(c.req.valid("query").environmentId))
  )
  .post(
    "/create-database-backup",
    json(
      z.object({
        environmentId: uuidSchema,
        options: z
          .object({
            compress: z.boolean().optional(),
            database: targetDatabase,
          })
          .optional(),
      })
    ),
    async (c) => {
      const { environmentId, options } = c.req.valid("json");
      return c.json(await createDatabaseBackup(environmentId, options));
    }
  )
  .post(
    "/restore-database-backup",
    json(
      z.object({
        environmentId: uuidSchema,
        options: z.object({
          filename: backupFilenameSchema,
          restartBackend: z.boolean().optional(),
          database: targetDatabase,
          sourceEnvironmentId: uuidSchema.optional(),
        }),
      })
    ),
    async (c) => {
      const { environmentId, options } = c.req.valid("json");
      return c.json(await restoreDatabaseBackup(environmentId, options));
    }
  );
