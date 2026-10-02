import type { NextRequest } from "next/server";
import { getMailpitRaw } from "@/lib/mailpit/client";
import {
  attachmentDisposition,
  DOWNLOAD_HEADERS,
  mailpitErrorResponse,
} from "@/lib/mailpit/download";
import { authorizeMailRoute } from "@/lib/mailpit/route";
import { mailpitIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Downloads the full RFC 822 source of a captured email as `<id>.eml`.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ environmentId: string; messageId: string }> }
) {
  const { environmentId, messageId } = await params;
  if (!mailpitIdSchema.safeParse(messageId).success) {
    return new Response("Not found", { status: 404 });
  }
  const auth = await authorizeMailRoute(environmentId);
  if (!auth.ok) return auth.response;

  try {
    const upstream = await getMailpitRaw(auth.cfg, messageId);
    return new Response(upstream.body, {
      headers: {
        ...DOWNLOAD_HEADERS,
        "Content-Disposition": attachmentDisposition(`${messageId}.eml`),
      },
    });
  } catch (err) {
    return mailpitErrorResponse(err);
  }
}
