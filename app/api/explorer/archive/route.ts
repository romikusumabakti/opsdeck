import type { Readable } from "node:stream";
import { Readable as NodeReadable } from "node:stream";
import { type NextRequest, NextResponse } from "next/server";
import { ZipFile } from "yazl";
import { z } from "zod";
import { getServerSession, isAdmin } from "@/lib/auth-session";
import { type ExplorerSource, resolveBackend } from "@/lib/explorer";
import {
  collectTree,
  MAX_TREE_ENTRIES,
  type Tree,
  TreeTooLargeError,
} from "@/lib/explorer/ops";
import { basename, dirname, PathError } from "@/lib/explorer/path";
import { explorerPathSchema, explorerSourceSchema } from "@/lib/validation";

// Folder download: walks the tree and streams it back as a ZIP. Admin-gated,
// same bar as every other explorer entry point. Node runtime for the ssh2
// socket and the zip stream.
//
// `path` may be repeated: one directory (the folder download) or a selection of
// files and folders, which are archived side by side under their own names.
//
// Nothing is buffered: yazl's addReadStreamLazy opens each file only when the
// archive reaches that entry, so exactly one backend read stream is live at a
// time (critical over SFTP, where each stream is its own SSH connection) and
// the response applies backpressure all the way down to the source.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Above this, ZIP needs the zip64 record layout. Sizes come from the listing,
// which can be stale, so the flag is set generously — zip64 for an entry that
// turns out smaller is still a valid archive.
const ZIP64_THRESHOLD = 0xff_ff_ff_ff;

export async function GET(req: NextRequest) {
  const session = await getServerSession();
  if (!session || !isAdmin(session)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  let source: ExplorerSource;
  try {
    source = explorerSourceSchema.parse(
      JSON.parse(req.nextUrl.searchParams.get("source") ?? "")
    );
  } catch {
    return new NextResponse("Invalid source", { status: 400 });
  }
  // No `path` at all means the root folder, which is also the empty string.
  const requested = req.nextUrl.searchParams.getAll("path");
  const parsedPaths = z
    .array(explorerPathSchema)
    .nonempty()
    .safeParse(requested.length > 0 ? requested : [""]);
  if (!parsedPaths.success) {
    return new NextResponse("Invalid path", { status: 400 });
  }
  const targets = parsedPaths.data;
  // One directory on its own is the "download this folder" case: its contents
  // sit at the archive root, so unzipping doesn't produce a doubled folder.
  // Every other shape (a selection, or a single file) is nested under its own
  // name, which is also what keeps a mixed selection from colliding.
  const first = targets[0] ?? "";
  const flat = targets.length === 1 && (first === "" || first.endsWith("/"));

  const backend = await resolveBackend(source);
  if (!backend) return new NextResponse("Not found", { status: 404 });

  const tree: Tree = { files: [], emptyDirs: [] };
  try {
    for (const target of targets) {
      const prefix = flat ? "" : basename(target);
      if (target === "" || target.endsWith("/")) {
        const sub = await collectTree(backend, target);
        for (const file of sub.files) {
          tree.files.push({
            ...file,
            relPath: prefix ? `${prefix}/${file.relPath}` : file.relPath,
          });
        }
        for (const empty of sub.emptyDirs) {
          tree.emptyDirs.push(prefix ? `${prefix}/${empty}` : empty);
        }
        // A selected folder that holds nothing still belongs in the archive;
        // collectTree only reports empty dirs it finds *below* its own root.
        if (prefix && sub.files.length === 0 && sub.emptyDirs.length === 0) {
          tree.emptyDirs.push(`${prefix}/`);
        }
      } else {
        const info = await backend.stat(target);
        if (!info) return new NextResponse("Not found", { status: 404 });
        tree.files.push({
          path: target,
          relPath: prefix,
          sizeBytes: info.sizeBytes,
          modifiedAt: info.modifiedAt,
        });
      }
      // collectTree bounds each walk on its own; the selection as a whole needs
      // the same ceiling applied across all of them.
      if (tree.files.length > MAX_TREE_ENTRIES) {
        throw new TreeTooLargeError(`Tree exceeds ${MAX_TREE_ENTRIES} entries`);
      }
    }
  } catch (error) {
    if (error instanceof TreeTooLargeError) {
      return new NextResponse("Folder is too large to download", {
        status: 413,
      });
    }
    if (error instanceof PathError) {
      return new NextResponse("Invalid path", { status: 400 });
    }
    console.error("Explorer archive listing failed:", error);
    return new NextResponse("Download failed", { status: 500 });
  }

  const zip = new ZipFile();
  // The response headers are already on the wire by the time a file read can
  // fail, so there is no status code left to send. Destroying the output stream
  // aborts the transfer — the browser reports a failed download instead of
  // silently saving a truncated archive.
  zip.on("error", (error) => {
    console.error("Explorer archive failed:", error);
    (zip.outputStream as Readable).destroy(error as Error);
  });
  for (const emptyDir of tree.emptyDirs) {
    zip.addEmptyDirectory(emptyDir);
  }
  for (const file of tree.files) {
    zip.addReadStreamLazy(
      file.relPath,
      {
        ...(file.modifiedAt ? { mtime: file.modifiedAt } : {}),
        forceZip64Format: (file.sizeBytes ?? 0) >= ZIP64_THRESHOLD,
      },
      (cb) => {
        backend.readStream(file.path).then(
          (stream) => cb(null, stream),
          (error) => cb(error, null as never)
        );
      }
    );
  }
  // Entries are already queued; end() only writes the central directory once
  // the last one has been pumped.
  zip.end();

  // One target names itself; a selection is named after the folder it came from.
  const name = `${
    (targets.length === 1 ? basename(first) : basename(dirname(first))) ||
    "archive"
  }.zip`;
  return new NextResponse(
    NodeReadable.toWeb(
      zip.outputStream as Readable
    ) as unknown as ReadableStream,
    {
      headers: {
        "Content-Type": "application/zip",
        // RFC 5987 encoding so non-ASCII names survive the header.
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    }
  );
}
