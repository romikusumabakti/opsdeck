import type { Readable } from "node:stream";
import { Readable as NodeReadable } from "node:stream";
import { type NextRequest, NextResponse } from "next/server";
import { ZipFile } from "yazl";
import { getServerSession, isAdmin } from "@/lib/auth-session";
import { type ExplorerSource, resolveBackend } from "@/lib/explorer";
import { collectTree, TreeTooLargeError } from "@/lib/explorer/ops";
import { basename, PathError } from "@/lib/explorer/path";
import { explorerPathSchema, explorerSourceSchema } from "@/lib/validation";

// Folder download: walks the tree and streams it back as a ZIP. Admin-gated,
// same bar as every other explorer entry point. Node runtime for the ssh2
// socket and the zip stream.
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
  const parsedPath = explorerPathSchema.safeParse(
    req.nextUrl.searchParams.get("path") ?? ""
  );
  // "" is the root; anything else must be a directory, which the whole explorer
  // marks with a trailing slash.
  if (
    !parsedPath.success ||
    (parsedPath.data && !parsedPath.data.endsWith("/"))
  ) {
    return new NextResponse("Invalid path", { status: 400 });
  }
  const dir = parsedPath.data;

  const backend = await resolveBackend(source);
  if (!backend) return new NextResponse("Not found", { status: 404 });

  let tree: Awaited<ReturnType<typeof collectTree>>;
  try {
    tree = await collectTree(backend, dir);
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

  const name = `${basename(dir) || "archive"}.zip`;
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
