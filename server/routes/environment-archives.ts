import { Readable } from "node:stream";
import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  listEnvironmentArchives,
  openArchiveFile,
} from "@/server/services/environment-archives";
import { requireInstanceManage } from "@/server/services/instance-backups";
import { param } from "@/server/validation";

/**
 * The archives of deleted environments (Admin → Instance → Backups), mounted
 * at /api/instance/environment-archives: org instance:manage, checked here
 * first and again by each service function.
 */
export const environmentArchivesRouter = sessionRouter()
  // Before any validator, so a non-admin always gets 403 `forbidden`.
  .use(async (_c, next) => {
    await requireInstanceManage();
    await next();
  })
  .get("/", async (c) => c.json(await listEnvironmentArchives()))
  .get(
    "/:id/files/:name",
    param(z.object({ id: uuidSchema, name: z.string().min(1).max(255) })),
    async (c) => {
      const { id, name } = c.req.valid("param");
      const file = await openArchiveFile(id, name);
      // node:stream/web's ReadableStream and the global one are the same
      // object at runtime but structurally distinct types.
      return new Response(
        Readable.toWeb(file.stream) as unknown as ReadableStream,
        {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(file.size),
            // RFC 5987 encoding so any name survives the header.
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            "Cache-Control": "private, no-store",
          },
        }
      );
    }
  );
