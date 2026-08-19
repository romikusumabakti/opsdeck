import { Readable } from "node:stream";
import { type NextRequest, NextResponse } from "next/server";
import { getServerSession, isAdmin } from "@/lib/auth-session";
import { type ExplorerSource, resolveBackend } from "@/lib/explorer";
import { ensureDir } from "@/lib/explorer/ops";
import { dirname, joinPath, PathError } from "@/lib/explorer/path";
import {
  explorerNameSchema,
  explorerPathSchema,
  explorerRelativePathSchema,
  explorerSourceSchema,
} from "@/lib/validation";

// Proxy upload: streams a multipart file body straight into the backend's write
// stream (S3 PutObject / SFTP write) without buffering the whole file. Admin-
// gated. Node runtime for the ssh2 socket + Node stream piping.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session || !isAdmin(session)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return new NextResponse("Missing file", { status: 400 });
  }

  let source: ExplorerSource;
  try {
    source = explorerSourceSchema.parse(JSON.parse(String(form.get("source"))));
  } catch {
    return new NextResponse("Invalid source", { status: 400 });
  }
  const parsedDir = explorerPathSchema.safeParse(form.get("path") ?? "");
  // Where the file lands under the destination directory. A folder upload sends
  // the browser's relative path ("dist/assets/app.js"); a plain file upload
  // sends nothing and the stored name is the file's own. Both are client-
  // supplied, so both are validated segment by segment before the join.
  const rawRelative = form.get("relativePath");
  const parsedRelative =
    typeof rawRelative === "string" && rawRelative.length > 0
      ? explorerRelativePathSchema.safeParse(rawRelative)
      : explorerNameSchema.safeParse(file.name);
  if (!parsedDir.success || !parsedRelative.success) {
    return new NextResponse("Invalid path", { status: 400 });
  }

  const backend = await resolveBackend(source);
  if (!backend) return new NextResponse("Not found", { status: 404 });

  const dest = joinPath(parsedDir.data, parsedRelative.data);

  try {
    // Blob.stream() hands out a fresh stream per call, so the retry below can
    // re-read the body after the first attempt consumed it.
    await backend.writeStream(dest, Readable.fromWeb(file.stream() as never));
  } catch (error) {
    if (error instanceof PathError) {
      return new NextResponse("Invalid path", { status: 400 });
    }
    // A folder upload sends its files in whatever order the browser queued
    // them, so the parent directory may not exist yet on a backend with real
    // directories (SFTP). Creating it up front would cost a mkdir round trip
    // per file; creating it only after a write fails costs nothing in the
    // common case.
    if (!parsedRelative.data.includes("/")) {
      console.error("Explorer upload failed:", error);
      return new NextResponse("Upload failed", { status: 500 });
    }
    try {
      await ensureDir(backend, dirname(dest));
      await backend.writeStream(dest, Readable.fromWeb(file.stream() as never));
    } catch (retryError) {
      console.error("Explorer upload failed:", retryError);
      return new NextResponse("Upload failed", { status: 500 });
    }
  }
  return NextResponse.json({ ok: true });
}
