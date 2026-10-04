"use server";

import { recordActivity } from "@/lib/activity";
import { requireProjectPermission } from "@/lib/authz";
import { environmentName } from "@/lib/environments";
import {
  deleteMailpitMessages,
  deleteMailpitSearch,
  getMailpitHeaders,
  getMailpitMessage,
  getMailpitPart,
  getMailpitRaw,
  listMailpitMessages,
  type MailpitConfig,
  MailpitError,
} from "@/lib/mailpit/client";
import { loadMailpitConfig } from "@/lib/mailpit/config";
import {
  inlineCids,
  pickInlineParts,
  referencedCids,
  toDataUri,
  withPrelude,
} from "@/lib/mailpit/html";
import type { MailMessage, MessagesPage } from "@/lib/mailpit/schemas";
import type { ProjectPermissions } from "@/lib/permissions";
import {
  mailDeleteTargetSchema,
  mailListInputSchema,
  mailpitIdSchema,
  uuidSchema,
} from "@/lib/validation";

export type MailResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; notFound?: boolean };

export type MailDetail = {
  message: Omit<MailMessage, "HTML">;
  // Prepared for <iframe srcdoc sandbox> (see lib/mailpit/html), or null.
  html: string | null;
  headers: Record<string, string[]>;
};

// The Raw tab is a preview; the full source is the .eml download.
const MAX_SOURCE_BYTES = 1024 * 1024;

type Fail = { success: false; error: string; notFound?: boolean };

// Validate + authorize + load config for one inbox action. The Mailpit URL and
// credentials come from the DB, never the client (SSRF).
async function requireMail(
  environmentId: string,
  perms: ProjectPermissions = { mail: ["read"] }
): Promise<
  { ok: true; cfg: MailpitConfig; userId: string } | { ok: false; fail: Fail }
> {
  if (!uuidSchema.safeParse(environmentId).success) {
    return {
      ok: false,
      fail: { success: false, error: "Invalid environment id" },
    };
  }
  const { session } = await requireProjectPermission({ environmentId }, perms);
  const cfg = await loadMailpitConfig(environmentId);
  if (!cfg) {
    return {
      ok: false,
      fail: {
        success: false,
        error: "Mailpit is not configured for this environment",
      },
    };
  }
  return { ok: true, cfg, userId: session.user.id };
}

function failure(err: unknown): Fail {
  if (err instanceof MailpitError) {
    return { success: false, error: err.message, notFound: err.status === 404 };
  }
  console.error("Mailpit request failed:", err);
  return { success: false, error: "Mailpit request failed" };
}

export async function listMail(
  environmentId: string,
  input: unknown
): Promise<MailResult<MessagesPage>> {
  const auth = await requireMail(environmentId);
  if (!auth.ok) return auth.fail;
  const parsed = mailListInputSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid search" };
  try {
    return {
      success: true,
      data: await listMailpitMessages(auth.cfg, parsed.data),
    };
  } catch (err) {
    return failure(err);
  }
}

async function prepareHtml(
  cfg: MailpitConfig,
  message: MailMessage
): Promise<string | null> {
  if (!message.HTML) return null;
  const parts = pickInlineParts(message.Inline, referencedCids(message.HTML));
  const dataUris = new Map<string, string>();
  await Promise.all(
    parts.map(async (part) => {
      try {
        const res = await getMailpitPart(cfg, message.ID, part.PartID);
        const bytes = new Uint8Array(await res.arrayBuffer());
        dataUris.set(part.ContentID, toDataUri(part.ContentType, bytes));
      } catch {
        // A missing inline image renders broken; the message still opens.
      }
    })
  );
  return withPrelude(inlineCids(message.HTML, dataUris));
}

export async function getMail(
  environmentId: string,
  messageId: string
): Promise<MailResult<MailDetail>> {
  const auth = await requireMail(environmentId);
  if (!auth.ok) return auth.fail;
  if (!mailpitIdSchema.safeParse(messageId).success) {
    return { success: false, error: "Invalid message id" };
  }
  try {
    // Mailpit marks the message read on this GET — no separate call needed.
    const [message, headers] = await Promise.all([
      getMailpitMessage(auth.cfg, messageId),
      getMailpitHeaders(auth.cfg, messageId),
    ]);
    const { HTML: _html, ...rest } = message;
    return {
      success: true,
      data: {
        message: rest,
        html: await prepareHtml(auth.cfg, message),
        headers,
      },
    };
  } catch (err) {
    return failure(err);
  }
}

export async function getMailSource(
  environmentId: string,
  messageId: string
): Promise<MailResult<{ source: string; truncated: boolean }>> {
  const auth = await requireMail(environmentId);
  if (!auth.ok) return auth.fail;
  if (!mailpitIdSchema.safeParse(messageId).success) {
    return { success: false, error: "Invalid message id" };
  }
  try {
    const res = await getMailpitRaw(auth.cfg, messageId);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const truncated = bytes.byteLength > MAX_SOURCE_BYTES;
    const source = new TextDecoder().decode(
      truncated ? bytes.subarray(0, MAX_SOURCE_BYTES) : bytes
    );
    return { success: true, data: { source, truncated } };
  } catch (err) {
    return failure(err);
  }
}

export async function deleteMail(
  environmentId: string,
  target: unknown
): Promise<MailResult<null>> {
  const auth = await requireMail(environmentId, { mail: ["delete"] });
  if (!auth.ok) return auth.fail;
  const parsed = mailDeleteTargetSchema.safeParse(target);
  if (!parsed.success) return { success: false, error: "Invalid selection" };
  const t = parsed.data;
  try {
    if (t.scope === "ids") await deleteMailpitMessages(auth.cfg, t.ids);
    else if (t.scope === "search") await deleteMailpitSearch(auth.cfg, t.query);
    else await deleteMailpitMessages(auth.cfg, "all");
  } catch (err) {
    return failure(err);
  }

  const environment = (await environmentName(environmentId)) ?? environmentId;
  await recordActivity({
    actorId: auth.userId,
    action:
      t.scope === "ids"
        ? "mail.deleted"
        : t.scope === "search"
          ? "mail.deleted_search"
          : "mail.cleared",
    entityType: "environment",
    entityId: environmentId,
    data:
      t.scope === "ids"
        ? { environment, count: t.ids.length }
        : t.scope === "search"
          ? { environment, query: t.query }
          : { environment },
  });
  return { success: true, data: null };
}
