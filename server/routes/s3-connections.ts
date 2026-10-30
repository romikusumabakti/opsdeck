import { z } from "zod";
import {
  s3ConnectionInputSchema,
  s3ConnectionUpdateSchema,
  uuidSchema,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  createS3Connection,
  deleteS3Connection,
  getS3Connection,
  getS3Connections,
  testS3ConnectionAction,
  updateS3Connection,
} from "@/server/services/s3-connections";
import { json, query } from "@/server/validation";

export const s3ConnectionsRouter = sessionRouter()
  .get("/get-s3-connections", async (c) => c.json(await getS3Connections()))
  .get("/get-s3-connection", query(z.object({ id: uuidSchema })), async (c) =>
    c.json((await getS3Connection(c.req.valid("query").id)) ?? null)
  )
  .post(
    "/create-s3-connection",
    json(z.object({ data: s3ConnectionInputSchema })),
    async (c) => c.json(await createS3Connection(c.req.valid("json").data))
  )
  .post(
    "/update-s3-connection",
    json(z.object({ id: uuidSchema, data: s3ConnectionUpdateSchema })),
    async (c) => {
      const { id, data } = c.req.valid("json");
      return c.json(await updateS3Connection(id, data));
    }
  )
  .post(
    "/delete-s3-connection",
    json(z.object({ id: uuidSchema })),
    async (c) => c.json(await deleteS3Connection(c.req.valid("json").id))
  )
  .post(
    "/test-s3-connection-action",
    // A probe of unsaved form values: the S3 client's own error is the answer,
    // so the fields are only bounded here.
    json(
      z.object({
        input: z.object({
          endpoint: z.string().max(2048),
          region: z.string().max(100),
          bucket: z.string().max(255),
          accessKeyId: z.string().max(512),
          secretKey: z.string().max(1024).optional(),
          forcePathStyle: z.boolean(),
          connectionId: uuidSchema.optional(),
        }),
      })
    ),
    async (c) => c.json(await testS3ConnectionAction(c.req.valid("json").input))
  );
