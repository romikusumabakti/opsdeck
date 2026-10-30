import { z } from "zod";
import { requireProjectPage } from "@/lib/authz";
import {
  getMailpitMessage,
  getMailpitPart,
  getMailpitRaw,
  mailpitAuthHeaders,
  mailpitEventsUrl,
} from "@/lib/mailpit/client";
import { loadMailpitConfig } from "@/lib/mailpit/config";
import {
  attachmentDisposition,
  DOWNLOAD_HEADERS,
  mailpitErrorResponse,
} from "@/lib/mailpit/download";
import { mailEventType } from "@/lib/mailpit/events";
import { authorizeMailRoute } from "@/lib/mailpit/route";
import {
  mailDeleteTargetSchema,
  mailpitIdSchema,
  mailpitPartIdSchema,
  uuidSchema,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  deleteMail,
  getMail,
  getMailSource,
  listMail,
} from "@/server/services/mail";
import { eventChannel, eventStream } from "@/server/sse";
import { json, jsonQuery, query } from "@/server/validation";

// The search box answers a bad query with the service's message, so the
// router only fixes the shape and bounds it.
const mailListInput = z.object({
  query: z.string().max(500).optional(),
  start: z.number().int().nonnegative().optional(),
});

const messageQuery = query(
  z.object({ environmentId: uuidSchema, messageId: mailpitIdSchema })
);

export const mailRouter = sessionRouter()
  .get(
    "/list-mail",
    jsonQuery(z.object({ environmentId: uuidSchema, input: mailListInput })),
    async (c) => {
      const { environmentId, input } = c.req.valid("query");
      return c.json(await listMail(environmentId, input));
    }
  )
  .get("/get-mail", messageQuery, async (c) => {
    const { environmentId, messageId } = c.req.valid("query");
    return c.json(await getMail(environmentId, messageId));
  })
  .get("/get-mail-source", messageQuery, async (c) => {
    const { environmentId, messageId } = c.req.valid("query");
    return c.json(await getMailSource(environmentId, messageId));
  })
  /**
   * Page data for the inbox page: whether the environment has a Mailpit
   * connection (the page shows a "not configured" state otherwise). Same guard
   * as the page — mail:read in the environment's project.
   */
  .get(
    "/configured",
    query(z.object({ environmentId: uuidSchema })),
    async (c) => {
      const { environmentId } = c.req.valid("query");
      await requireProjectPage({ environmentId }, { mail: ["read"] });
      return c.json({
        configured: Boolean(await loadMailpitConfig(environmentId)),
      });
    }
  )
  .post(
    "/delete-mail",
    json(
      z.object({ environmentId: uuidSchema, target: mailDeleteTargetSchema })
    ),
    async (c) => {
      const { environmentId, target } = c.req.valid("json");
      return c.json(await deleteMail(environmentId, target));
    }
  );

const MAX_DURATION_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
// Reconnect delay the browser uses after a drop — keeps a down Mailpit from
// being hammered by every open inbox tab.
const RETRY_MS = 10_000;

/**
 * The inbox endpoints ported from app/api/environments/[environmentId]/mail/**.
 * Mounted at /api/environments so their paths are unchanged.
 */
export const mailFilesRouter = sessionRouter()
  /**
   * Relays the environment's Mailpit /api/events WebSocket to the browser as
   * SSE, so the inbox refreshes when mail arrives. Capped duration +
   * heartbeat, and EventSource reconnects on close.
   */
  .get("/:environmentId/mail/events", async (c) => {
    const auth = await authorizeMailRoute(c.req.param("environmentId"));
    if (!auth.ok) return auth.response;
    const { cfg } = auth;

    return eventStream(c, async (stream) => {
      let socket: WebSocket | null = null;
      // Frames are queued in order and flushed before the stream closes, so
      // the final `stream-error` / `timeout` always reaches the client (see
      // server/sse.ts).
      const channel = eventChannel(stream, {
        maxDurationMs: MAX_DURATION_MS,
        heartbeatMs: HEARTBEAT_INTERVAL_MS,
        onClose: () => socket?.close(),
      });
      const send = channel.send;
      if (channel.closed) return;
      channel.write(`retry: ${RETRY_MS}\n\n`);

      try {
        // Bun and Node (undici) both accept a non-standard `headers` init —
        // the only way to send Basic Auth on the upgrade request.
        socket = new WebSocket(mailpitEventsUrl(cfg.url), {
          headers: mailpitAuthHeaders(cfg),
        } as unknown as string[]);
      } catch (err) {
        send("stream-error", {
          message: err instanceof Error ? err.message : "Failed to connect",
        });
        channel.close();
        await channel.done;
        return;
      }

      socket.addEventListener("open", () => send("ready", {}));
      socket.addEventListener("message", (event) => {
        const type = mailEventType(event.data);
        if (type) send("mail", { type });
      });
      socket.addEventListener("error", () => {
        send("stream-error", { message: "Mailpit event stream failed" });
        channel.close();
      });
      socket.addEventListener("close", () => channel.close());

      await channel.done;
    });
  })
  /** Downloads the full RFC 822 source of a captured email as `<id>.eml`. */
  .get("/:environmentId/mail/:messageId/raw", async (c) => {
    const { environmentId, messageId } = c.req.param();
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
  })
  /** Streams one attachment/inline part of a captured email as a download. */
  .get("/:environmentId/mail/:messageId/part/:partId", async (c) => {
    const { environmentId, messageId, partId } = c.req.param();
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
  });
