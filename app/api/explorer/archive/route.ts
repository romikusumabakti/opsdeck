import { Readable as NodeReadable } from "node:stream";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession, isAdmin } from "@/lib/auth-session";
import { type ExplorerSource, resolveBackend } from "@/lib/explorer";
import { zipStream } from "@/lib/explorer/archive";
import {
  collectSelection,
  MissingEntryError,
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
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const first = targets[0] ?? "";
  const flat = targets.length === 1 && (first === "" || first.endsWith("/"));

  const backend = await resolveBackend(source);
  if (!backend) return new NextResponse("Not found", { status: 404 });

  let tree: Tree;
  try {
    tree = await collectSelection(backend, targets, flat);
  } catch (error) {
    if (error instanceof TreeTooLargeError) {
      return new NextResponse("Folder is too large to download", {
        status: 413,
      });
    }
    if (error instanceof MissingEntryError) {
      return new NextResponse("Not found", { status: 404 });
    }
    if (error instanceof PathError) {
      return new NextResponse("Invalid path", { status: 400 });
    }
    console.error("Explorer archive listing failed:", error);
    return new NextResponse("Download failed", { status: 500 });
  }

  // One target names itself; a selection is named after the folder it came from.
  const name = `${
    (targets.length === 1 ? basename(first) : basename(dirname(first))) ||
    "archive"
  }.zip`;
  return new NextResponse(
    NodeReadable.toWeb(zipStream(backend, tree)) as unknown as ReadableStream,
    {
      headers: {
        "Content-Type": "application/zip",
        // RFC 5987 encoding so non-ASCII names survive the header.
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    }
  );
}
