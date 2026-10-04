import "server-only";

import type { z } from "zod";
import { describeFetchError } from "@/lib/fetch-error";
import {
  MAIL_PAGE_SIZE,
  type MailMessage,
  type MailpitInfo,
  type MessagesPage,
  mailMessageSchema,
  mailpitInfoSchema,
  messageHeadersSchema,
  messagesPageSchema,
} from "./schemas";

// Thin typed client for one environment's Mailpit REST API. The config always
// comes from lib/mailpit/config (the DB), never from the browser — that's what
// keeps these server-side fetches from being pointed at arbitrary hosts.

export type MailpitConfig = {
  url: string;
  username: string | null;
  password: string | null;
};

export class MailpitError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "MailpitError";
    this.status = status;
  }
}

const API_TIMEOUT_MS = 10_000;
// Raw sources and attachments stream through us; give big ones room.
const DOWNLOAD_TIMEOUT_MS = 60_000;

type Params = Record<string, string | number | undefined>;

export function mailpitUrl(base: string, path: string, params: Params = {}) {
  // Treat the base as a directory so a webroot (`/mailpit`) survives: URL
  // resolution would otherwise replace its last segment.
  const root = base.endsWith("/") ? base : `${base}/`;
  const url = new URL(path.replace(/^\/+/, ""), root);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function mailpitEventsUrl(base: string): string {
  const url = new URL(mailpitUrl(base, "api/events"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function mailpitAuthHeaders(cfg: MailpitConfig): Record<string, string> {
  if (!cfg.username) return {};
  const token = Buffer.from(`${cfg.username}:${cfg.password ?? ""}`).toString(
    "base64"
  );
  return { Authorization: `Basic ${token}` };
}

export function describeMailpitStatus(status: number, statusText: string) {
  if (status === 401 || status === 403) {
    return "Mailpit authentication failed — check the environment's Mailpit settings";
  }
  if (status === 404) return "Not found in Mailpit";
  return `Mailpit responded ${status} ${statusText}`.trim();
}

type RequestOptions = {
  method?: "GET" | "DELETE";
  params?: Params;
  body?: unknown;
  timeoutMs?: number;
};

async function request(
  cfg: MailpitConfig,
  path: string,
  opts: RequestOptions = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? API_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(mailpitUrl(cfg.url, path, opts.params), {
      method: opts.method ?? "GET",
      headers: {
        ...mailpitAuthHeaders(cfg),
        ...(opts.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      // Don't follow upstream redirects to other hosts.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "TimeoutError") {
      throw new MailpitError(
        `Mailpit did not respond within ${timeoutMs / 1000}s`
      );
    }
    throw new MailpitError(describeFetchError(err));
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new MailpitError(
      describeMailpitStatus(res.status, res.statusText),
      res.status
    );
  }
  return res;
}

async function parse<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success)
    throw new MailpitError("Unexpected response from Mailpit");
  return parsed.data;
}

const messagePath = (id: string) => `api/v1/message/${encodeURIComponent(id)}`;

export async function getMailpitInfo(cfg: MailpitConfig): Promise<MailpitInfo> {
  return parse(await request(cfg, "api/v1/info"), mailpitInfoSchema);
}

export async function listMailpitMessages(
  cfg: MailpitConfig,
  { query, start }: { query: string; start: number }
): Promise<MessagesPage> {
  const params = { start, limit: MAIL_PAGE_SIZE };
  const res = query
    ? await request(cfg, "api/v1/search", { params: { ...params, query } })
    : await request(cfg, "api/v1/messages", { params });
  return parse(res, messagesPageSchema);
}

// Note: Mailpit marks the message read as a side effect of this GET.
export async function getMailpitMessage(
  cfg: MailpitConfig,
  id: string
): Promise<MailMessage> {
  return parse(await request(cfg, messagePath(id)), mailMessageSchema);
}

export async function getMailpitHeaders(
  cfg: MailpitConfig,
  id: string
): Promise<Record<string, string[]>> {
  return parse(
    await request(cfg, `${messagePath(id)}/headers`),
    messageHeadersSchema
  );
}

export function getMailpitRaw(cfg: MailpitConfig, id: string) {
  return request(cfg, `${messagePath(id)}/raw`, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
}

export function getMailpitPart(cfg: MailpitConfig, id: string, partId: string) {
  return request(cfg, `${messagePath(id)}/part/${encodeURIComponent(partId)}`, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
}

export async function deleteMailpitMessages(
  cfg: MailpitConfig,
  ids: string[] | "all"
): Promise<void> {
  // Mailpit reads an empty IDs list as "delete everything". Only an explicit
  // "all" may produce one — an empty selection is a caller bug.
  if (ids !== "all" && ids.length === 0) {
    throw new MailpitError("No messages selected");
  }
  const res = await request(cfg, "api/v1/messages", {
    method: "DELETE",
    body: { IDs: ids === "all" ? [] : ids },
  });
  await res.body?.cancel();
}

export async function deleteMailpitSearch(
  cfg: MailpitConfig,
  query: string
): Promise<void> {
  if (!query.trim()) throw new MailpitError("Empty search");
  const res = await request(cfg, "api/v1/search", {
    method: "DELETE",
    params: { query },
  });
  await res.body?.cancel();
}
