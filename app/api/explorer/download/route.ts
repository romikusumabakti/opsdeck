import { Readable } from "node:stream";
import { type NextRequest, NextResponse } from "next/server";
import { getServerSession, isAdmin } from "@/lib/auth-session";
import { type ExplorerSource, resolveBackend } from "@/lib/explorer";
import { basename, PathError } from "@/lib/explorer/path";
import { explorerPathSchema, explorerSourceSchema } from "@/lib/validation";

// Proxy download: streams a file's bytes through the server for backends that
// can't hand the browser a direct URL (SFTP). S3 normally uses a presigned URL
// instead (see getDownloadTarget), but this route also works for it as a
// fallback. Admin-gated — same trust bar as the explorer actions. Node runtime:
// Edge can't hold an ssh2 socket.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getServerSession();
  if (!session || !isAdmin(session)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const rawSource = req.nextUrl.searchParams.get("source");
  const rawPath = req.nextUrl.searchParams.get("path");
  let source: ExplorerSource;
  try {
    source = explorerSourceSchema.parse(JSON.parse(rawSource ?? ""));
  } catch {
    return new NextResponse("Invalid source", { status: 400 });
  }
  const parsedPath = explorerPathSchema.safeParse(rawPath ?? "");
  if (!parsedPath.success || !parsedPath.data) {
    return new NextResponse("Invalid path", { status: 400 });
  }

  const backend = await resolveBackend(source);
  if (!backend) return new NextResponse("Not found", { status: 404 });

  try {
    const stream = await backend.readStream(parsedPath.data);
    const filename = basename(parsedPath.data);
    // node:stream/web's ReadableStream and the global one are the same object
    // at runtime but structurally distinct types, so the cast goes via unknown.
    return new NextResponse(
      Readable.toWeb(stream) as unknown as ReadableStream,
      {
        headers: {
          "Content-Type": "application/octet-stream",
          // RFC 5987 encoding so non-ASCII names survive the header.
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        },
      }
    );
  } catch (error) {
    if (error instanceof PathError) {
      return new NextResponse("Invalid path", { status: 400 });
    }
    console.error("Explorer download failed:", error);
    return new NextResponse("Download failed", { status: 500 });
  }
}
