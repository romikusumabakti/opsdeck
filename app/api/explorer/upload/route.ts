import { Readable } from "node:stream";
import { type NextRequest, NextResponse } from "next/server";
import { getServerSession, isAdmin } from "@/lib/auth-session";
import { type ExplorerSource, resolveBackend } from "@/lib/explorer";
import { PathError } from "@/lib/explorer/path";
import {
  explorerNameSchema,
  explorerPathSchema,
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
  // The stored filename comes from the client; validate it as a single segment
  // so it can't inject path separators or traversal into the destination key.
  const parsedName = explorerNameSchema.safeParse(file.name);
  if (!parsedDir.success || !parsedName.success) {
    return new NextResponse("Invalid path", { status: 400 });
  }

  const backend = await resolveBackend(source);
  if (!backend) return new NextResponse("Not found", { status: 404 });

  const base = parsedDir.data.replace(/\/+$/, "");
  const dest = base ? `${base}/${parsedName.data}` : parsedName.data;

  try {
    const body = Readable.fromWeb(file.stream() as never);
    await backend.writeStream(dest, body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof PathError) {
      return new NextResponse("Invalid path", { status: 400 });
    }
    console.error("Explorer upload failed:", error);
    return new NextResponse("Upload failed", { status: 500 });
  }
}
