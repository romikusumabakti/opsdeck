import type { NextRequest } from "next/server";
import { getMailpitMessage, getMailpitPart } from "@/lib/mailpit/client";
import {
  attachmentDisposition,
  DOWNLOAD_HEADERS,
  mailpitErrorResponse,
} from "@/lib/mailpit/download";
import { authorizeMailRoute } from "@/lib/mailpit/route";
import { mailpitIdSchema, mailpitPartIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Streams one attachment/inline part of a captured email as a download.
export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      environmentId: string;
      messageId: string;
      partId: string;
    }>;
  }
) {
  const { environmentId, messageId, partId } = await params;
  if (
    !mailpitIdSchema.safeParse(messageId).success ||
    !mailpitPartIdSchema.safeParse(partId).success
  ) {
    return new Response("Not found", { status: 404 });
  }
  const auth = await authorizeMailRoute(environmentId);
  if (!auth.ok) return auth.response;

  try {
    // Resolve the part from the message itself: a trusted filename, and part
    // ids the message doesn't declare are refused.
    const message = await getMailpitMessage(auth.cfg, messageId);
    const part = [...message.Attachments, ...message.Inline].find(
      (p) => p.PartID === partId
    );
    if (!part) return new Response("Not found", { status: 404 });

    const upstream = await getMailpitPart(auth.cfg, messageId, partId);
    return new Response(upstream.body, {
      headers: {
        ...DOWNLOAD_HEADERS,
        "Content-Disposition": attachmentDisposition(
          part.FileName || `part-${partId}`
        ),
      },
    });
  } catch (err) {
    return mailpitErrorResponse(err);
  }
}
