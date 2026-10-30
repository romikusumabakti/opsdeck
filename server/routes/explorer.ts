import { Readable } from "node:stream";
import { z } from "zod";
import { routeOrgGuard } from "@/lib/authz";
import { type ExplorerSource, resolveBackend } from "@/lib/explorer";
import { zipStream } from "@/lib/explorer/archive";
import {
  collectSelection,
  ensureDir,
  MissingEntryError,
  type Tree,
  TreeTooLargeError,
} from "@/lib/explorer/ops";
import { basename, dirname, joinPath, PathError } from "@/lib/explorer/path";
import {
  explorerEolSchema,
  explorerNameSchema,
  explorerPathSchema,
  explorerRelativePathSchema,
  explorerSourceSchema,
  MAX_EDITABLE_BYTES,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  compressEntries,
  copyEntry,
  createFolder,
  deleteEntry,
  folderStats,
  getDownloadTarget,
  listEntries,
  moveEntry,
  readFileText,
  renameEntry,
  saveFileText,
} from "@/server/services/explorer";
import { json, jsonQuery } from "@/server/validation";

// The source descriptor (ids only, never credentials) is structural, so it is
// validated here. Paths, names and file content are the service's call: it
// answers a bad one with a translated message the explorer shows, so they are
// only bounded here.
const source = explorerSourceSchema;
const path = z.string().max(4096);
const name = z.string().max(1024);
// Edited content: the service enforces MAX_EDITABLE_BYTES (UTF-8) with its own
// message; this is a ceiling on what is parsed at all. UTF-16 length never
// exceeds the byte count, so nothing the service would accept is refused.
const content = z.string().max(MAX_EDITABLE_BYTES);
const entryQuery = jsonQuery(z.object({ source, path: path.optional() }));

export const explorerRouter = sessionRouter()
  .get("/list-entries", entryQuery, async (c) => {
    const { source, path } = c.req.valid("query");
    return c.json(await listEntries(source, path));
  })
  .get("/get-download-target", entryQuery, async (c) => {
    const { source, path } = c.req.valid("query");
    return c.json(await getDownloadTarget(source, path));
  })
  .get("/read-file-text", entryQuery, async (c) => {
    const { source, path } = c.req.valid("query");
    return c.json(await readFileText(source, path));
  })
  // A recursive walk for the properties dialog, so the client asks for it only
  // when the dialog opens.
  .get("/folder-stats", entryQuery, async (c) => {
    const { source, path } = c.req.valid("query");
    return c.json(await folderStats(source, path));
  })
  .post(
    "/save-file-text",
    json(z.object({ source, path, content, eol: explorerEolSchema })),
    async (c) => {
      const { source, path, content, eol } = c.req.valid("json");
      return c.json(await saveFileText(source, path, content, eol));
    }
  )
  .post(
    "/create-folder",
    json(z.object({ source, parentPath: path.optional(), name })),
    async (c) => {
      const { source, parentPath, name } = c.req.valid("json");
      return c.json(await createFolder(source, parentPath, name));
    }
  )
  .post("/delete-entry", json(z.object({ source, path })), async (c) => {
    const { source, path } = c.req.valid("json");
    return c.json(await deleteEntry(source, path));
  })
  .post(
    "/rename-entry",
    json(z.object({ source, path, newName: name })),
    async (c) => {
      const { source, path, newName } = c.req.valid("json");
      return c.json(await renameEntry(source, path, newName));
    }
  )
  .post(
    "/move-entry",
    json(z.object({ source, path, destDir: path.optional() })),
    async (c) => {
      const { source, path, destDir } = c.req.valid("json");
      return c.json(await moveEntry(source, path, destDir));
    }
  )
  .post(
    "/copy-entry",
    json(z.object({ source, path, destDir: path.optional() })),
    async (c) => {
      const { source, path, destDir } = c.req.valid("json");
      return c.json(await copyEntry(source, path, destDir));
    }
  )
  .post(
    "/compress-entries",
    json(
      z.object({
        source,
        // A selection from one listing page.
        paths: z.array(path).max(1000),
        destDir: path.optional(),
        name,
      })
    ),
    async (c) => {
      const { source, paths, destDir, name } = c.req.valid("json");
      return c.json(await compressEntries(source, paths, destDir, name));
    }
  )
  /**
   * Folder download, ported from app/api/explorer/archive: walks the tree and
   * streams it back as a ZIP. `path` may be repeated — one directory (the
   * folder download) or a selection archived side by side under their own
   * names. `source` is a JSON query parameter, as the explorer links build it.
   */
  .get("/archive", async (c) => {
    let src: ExplorerSource;
    try {
      src = explorerSourceSchema.parse(JSON.parse(c.req.query("source") ?? ""));
    } catch {
      return new Response("Invalid source", { status: 400 });
    }
    const guard = await routeOrgGuard(
      src.kind === "s3" ? { storage: ["files"] } : { server: ["files"] }
    );
    if (!guard.ok) return guard.response;
    // No `path` at all means the root folder, which is also the empty string.
    const requested = c.req.queries("path") ?? [];
    const parsedPaths = z
      .array(explorerPathSchema)
      .nonempty()
      .safeParse(requested.length > 0 ? requested : [""]);
    if (!parsedPaths.success) {
      return new Response("Invalid path", { status: 400 });
    }
    const targets = parsedPaths.data;
    // One directory on its own is the "download this folder" case: its
    // contents sit at the archive root, so unzipping doesn't produce a doubled
    // folder.
    const first = targets[0] ?? "";
    const flat = targets.length === 1 && (first === "" || first.endsWith("/"));

    const backend = await resolveBackend(src);
    if (!backend) return new Response("Not found", { status: 404 });

    let tree: Tree;
    try {
      tree = await collectSelection(backend, targets, flat);
    } catch (error) {
      if (error instanceof TreeTooLargeError) {
        return new Response("Folder is too large to download", {
          status: 413,
        });
      }
      if (error instanceof MissingEntryError) {
        return new Response("Not found", { status: 404 });
      }
      if (error instanceof PathError) {
        return new Response("Invalid path", { status: 400 });
      }
      console.error("Explorer archive listing failed:", error);
      return new Response("Download failed", { status: 500 });
    }

    // One target names itself; a selection is named after the folder it came
    // from.
    const archiveName = `${
      (targets.length === 1 ? basename(first) : basename(dirname(first))) ||
      "archive"
    }.zip`;
    return new Response(
      Readable.toWeb(zipStream(backend, tree)) as unknown as ReadableStream,
      {
        headers: {
          "Content-Type": "application/zip",
          // RFC 5987 encoding so non-ASCII names survive the header.
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archiveName)}`,
        },
      }
    );
  })
  /**
   * Proxy download, ported from app/api/explorer/download: streams a file's
   * bytes through the server for backends that can't hand the browser a direct
   * URL (SFTP). S3 normally uses a presigned URL (get-download-target), but
   * this works for it as a fallback.
   */
  .get("/download", async (c) => {
    let src: ExplorerSource;
    try {
      src = explorerSourceSchema.parse(JSON.parse(c.req.query("source") ?? ""));
    } catch {
      return new Response("Invalid source", { status: 400 });
    }
    const guard = await routeOrgGuard(
      src.kind === "s3" ? { storage: ["files"] } : { server: ["files"] }
    );
    if (!guard.ok) return guard.response;
    const parsedPath = explorerPathSchema.safeParse(c.req.query("path") ?? "");
    if (!parsedPath.success || !parsedPath.data) {
      return new Response("Invalid path", { status: 400 });
    }

    const backend = await resolveBackend(src);
    if (!backend) return new Response("Not found", { status: 404 });

    try {
      const stream = await backend.readStream(parsedPath.data);
      const filename = basename(parsedPath.data);
      // node:stream/web's ReadableStream and the global one are the same
      // object at runtime but structurally distinct types, so the cast goes
      // via unknown.
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        headers: {
          "Content-Type": "application/octet-stream",
          // RFC 5987 encoding so non-ASCII names survive the header.
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        },
      });
    } catch (error) {
      if (error instanceof PathError) {
        return new Response("Invalid path", { status: 400 });
      }
      console.error("Explorer download failed:", error);
      return new Response("Download failed", { status: 500 });
    }
  })
  /**
   * Proxy upload, ported from app/api/explorer/upload: streams a multipart
   * file into the backend's write stream (S3 PutObject / SFTP write). The
   * session router has already authenticated before the body is read; the
   * permission check needs the source kind, which lives inside the form.
   */
  .post("/upload", async (c) => {
    const form = await c.req.raw.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) {
      return new Response("Missing file", { status: 400 });
    }

    let src: ExplorerSource;
    try {
      src = explorerSourceSchema.parse(JSON.parse(String(form.get("source"))));
    } catch {
      return new Response("Invalid source", { status: 400 });
    }
    const guard = await routeOrgGuard(
      src.kind === "s3" ? { storage: ["files"] } : { server: ["files"] }
    );
    if (!guard.ok) return guard.response;
    const parsedDir = explorerPathSchema.safeParse(form.get("path") ?? "");
    // Where the file lands under the destination directory. A folder upload
    // sends the browser's relative path ("dist/assets/app.js"); a plain file
    // upload sends nothing and the stored name is the file's own. Both are
    // client-supplied, so both are validated segment by segment before the
    // join.
    const rawRelative = form.get("relativePath");
    const parsedRelative =
      typeof rawRelative === "string" && rawRelative.length > 0
        ? explorerRelativePathSchema.safeParse(rawRelative)
        : explorerNameSchema.safeParse(file.name);
    if (!parsedDir.success || !parsedRelative.success) {
      return new Response("Invalid path", { status: 400 });
    }

    const backend = await resolveBackend(src);
    if (!backend) return new Response("Not found", { status: 404 });

    const dest = joinPath(parsedDir.data, parsedRelative.data);

    try {
      // Blob.stream() hands out a fresh stream per call, so the retry below
      // can re-read the body after the first attempt consumed it.
      await backend.writeStream(dest, Readable.fromWeb(file.stream() as never));
    } catch (error) {
      if (error instanceof PathError) {
        return new Response("Invalid path", { status: 400 });
      }
      // A folder upload sends its files in whatever order the browser queued
      // them, so the parent directory may not exist yet on a backend with real
      // directories (SFTP). Creating it up front would cost a mkdir round trip
      // per file; creating it only after a write fails costs nothing in the
      // common case.
      if (!parsedRelative.data.includes("/")) {
        console.error("Explorer upload failed:", error);
        return new Response("Upload failed", { status: 500 });
      }
      try {
        await ensureDir(backend, dirname(dest));
        await backend.writeStream(
          dest,
          Readable.fromWeb(file.stream() as never)
        );
      } catch (retryError) {
        console.error("Explorer upload failed:", retryError);
        return new Response("Upload failed", { status: 500 });
      }
    }
    return c.json({ ok: true });
  });
