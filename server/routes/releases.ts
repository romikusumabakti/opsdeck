import { Readable } from "node:stream";
import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  createRelease,
  createReleaseSchema,
  deleteRelease,
  listReleases,
  openReleaseDownload,
  updateReleaseNotes,
  updateReleaseNotesSchema,
} from "@/server/services/releases";
import { json, param } from "@/server/validation";

const idParam = param(z.object({ id: uuidSchema }));

/**
 * Releases: a tested jar/static build kept in the Panel's Garage. Listing
 * needs any project role; creating, editing notes and downloading need the
 * engineer role; deleting needs org `server:manage` (the services check them).
 * Each router is mounted under its own prefix: a session router guards its
 * whole prefix, so none may sit at /api, where public routes live.
 */

/** Mounted at /api/environments. */
export const environmentReleasesRouter = sessionRouter().post(
  "/:environmentId/releases",
  param(z.object({ environmentId: uuidSchema })),
  json(createReleaseSchema),
  async (c) =>
    c.json(
      await createRelease(
        c.req.valid("param").environmentId,
        c.req.valid("json")
      ),
      202
    )
);

/** Mounted at /api/projects. */
export const projectReleasesRouter = sessionRouter().get(
  "/:projectId/releases",
  param(z.object({ projectId: uuidSchema })),
  async (c) => c.json(await listReleases(c.req.valid("param").projectId))
);

/** Mounted at /api/releases. */
export const releasesRouter = sessionRouter()
  .patch("/:id", idParam, json(updateReleaseNotesSchema), async (c) =>
    c.json(
      await updateReleaseNotes(
        c.req.valid("param").id,
        c.req.valid("json").notes
      )
    )
  )
  .delete("/:id", idParam, async (c) => {
    await deleteRelease(c.req.valid("param").id);
    return c.body(null, 204);
  })
  .get("/:id/download", idParam, async (c) => {
    const { stream, fileName, sizeBytes } = await openReleaseDownload(
      c.req.valid("param").id
    );
    // A failure after the headers went out (Garage drops mid-download)
    // errors the web stream, which aborts the response; the client sees a
    // truncated body against Content-Length. Logging the error here keeps it
    // from being an unhandled one on the node stream.
    stream.on("error", (error) => {
      console.error("Release download failed mid-stream:", error.message);
    });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      headers: {
        "Content-Type": fileName.endsWith(".jar")
          ? "application/java-archive"
          : "application/zip",
        "Content-Length": String(sizeBytes),
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "private, no-store",
      },
    });
  });
