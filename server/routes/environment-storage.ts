import { z } from "zod";
import {
  environmentStorageInputSchema,
  environmentStorageUpdateSchema,
  uuidSchema,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  createEnvironmentStorage,
  deleteEnvironmentStorage,
  getEnvironmentStorage,
  listEnvironmentStorage,
  testEnvironmentStorage,
  updateEnvironmentStorage,
} from "@/server/services/environment-storage";
import { json, param } from "@/server/validation";

const envParam = param(z.object({ id: uuidSchema }));
const connectionParam = param(
  z.object({ id: uuidSchema, connectionId: uuidSchema })
);

/**
 * An environment's storage connections, mounted at /api/environments. Each
 * service function checks the environment's rights itself (view: project
 * read; manage: environment update + strong sign-in).
 */
export const environmentStorageRouter = sessionRouter()
  .get("/:id/storage", envParam, async (c) =>
    c.json(await listEnvironmentStorage(c.req.valid("param").id))
  )
  .post(
    "/:id/storage",
    envParam,
    json(environmentStorageInputSchema),
    async (c) =>
      c.json(
        await createEnvironmentStorage(
          c.req.valid("param").id,
          c.req.valid("json")
        )
      )
  )
  .post(
    "/:id/storage/test",
    envParam,
    // A probe of unsaved form values: the S3 client's own error is the
    // answer, so the fields are only bounded here.
    json(
      z.object({
        endpoint: z.string().max(2048),
        region: z.string().max(100),
        bucket: z.string().max(255),
        accessKeyId: z.string().max(512),
        secretKey: z.string().max(1024).optional(),
        forcePathStyle: z.boolean(),
        keyPrefix: z.string().max(2048).nullish(),
        connectionId: uuidSchema.optional(),
      })
    ),
    async (c) =>
      c.json(
        await testEnvironmentStorage(
          c.req.valid("param").id,
          c.req.valid("json")
        )
      )
  )
  .get("/:id/storage/:connectionId", connectionParam, async (c) => {
    const { id, connectionId } = c.req.valid("param");
    return c.json(await getEnvironmentStorage(id, connectionId));
  })
  .patch(
    "/:id/storage/:connectionId",
    connectionParam,
    json(environmentStorageUpdateSchema),
    async (c) => {
      const { id, connectionId } = c.req.valid("param");
      return c.json(
        await updateEnvironmentStorage(id, connectionId, c.req.valid("json"))
      );
    }
  )
  .delete("/:id/storage/:connectionId", connectionParam, async (c) => {
    const { id, connectionId } = c.req.valid("param");
    await deleteEnvironmentStorage(id, connectionId);
    return c.json({ ok: true });
  });
