import { z } from "zod";
import { databaseNameSchema, uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  createDatabase,
  dropDatabase,
  getDatabaseList,
  renameDatabase,
} from "@/server/services/databases";
import { json, query } from "@/server/validation";

export const databasesRouter = sessionRouter()
  // A synchronous SSH probe of the DB server: slow, so the client caches it
  // (staleTime 30s) rather than refetching on every navigation.
  .get(
    "/get-database-list",
    query(z.object({ environmentId: uuidSchema })),
    async (c) =>
      c.json(await getDatabaseList(c.req.valid("query").environmentId))
  )
  .post(
    "/create-database",
    json(
      z.object({
        environmentId: uuidSchema,
        options: z.object({ database: databaseNameSchema }),
      })
    ),
    async (c) => {
      const { environmentId, options } = c.req.valid("json");
      return c.json(await createDatabase(environmentId, options));
    }
  )
  .post(
    "/drop-database",
    json(
      z.object({
        environmentId: uuidSchema,
        options: z.object({ database: databaseNameSchema }),
      })
    ),
    async (c) => {
      const { environmentId, options } = c.req.valid("json");
      return c.json(await dropDatabase(environmentId, options));
    }
  )
  .post(
    "/rename-database",
    json(
      z.object({
        environmentId: uuidSchema,
        options: z.object({ from: databaseNameSchema, to: databaseNameSchema }),
      })
    ),
    async (c) => {
      const { environmentId, options } = c.req.valid("json");
      return c.json(await renameDatabase(environmentId, options));
    }
  );
