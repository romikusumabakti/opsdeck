import { z } from "zod";

// Response shapes of the Mailpit REST API (v1) — only the fields OpsDeck
// renders. Isomorphic: the inbox's client components import the types and
// MAIL_PAGE_SIZE from here, so nothing server-only may be imported.

export const MAIL_PAGE_SIZE = 50;

const addressSchema = z.object({ Name: z.string(), Address: z.string() });

// Go encodes a nil slice as `null`; normalise to [] so callers never branch.
function list<T extends z.ZodType>(item: T) {
  return z
    .array(item)
    .nullable()
    .transform((v) => v ?? []);
}

export const messageSummarySchema = z.object({
  ID: z.string(),
  Read: z.boolean(),
  From: addressSchema.nullable(),
  To: list(addressSchema),
  Subject: z.string(),
  Created: z.string(),
  Size: z.number(),
  Attachments: z.number(),
  Snippet: z.string(),
});

export const messagesPageSchema = z.object({
  total: z.number(),
  unread: z.number(),
  // Number of messages matching the current listing/search (pagination total).
  messages_count: z.number(),
  start: z.number(),
  messages: list(messageSummarySchema),
});

export const attachmentSchema = z.object({
  PartID: z.string(),
  FileName: z.string(),
  ContentType: z.string(),
  ContentID: z.string(),
  Size: z.number(),
});

export const mailMessageSchema = z.object({
  ID: z.string(),
  MessageID: z.string(),
  From: addressSchema.nullable(),
  To: list(addressSchema),
  Cc: list(addressSchema),
  Bcc: list(addressSchema),
  ReplyTo: list(addressSchema),
  Subject: z.string(),
  Date: z.string(),
  Text: z.string(),
  HTML: z.string(),
  Size: z.number(),
  Inline: list(attachmentSchema),
  Attachments: list(attachmentSchema),
});

export const messageHeadersSchema = z.record(z.string(), z.array(z.string()));

export const mailpitInfoSchema = z.object({
  Version: z.string(),
  Messages: z.number(),
  Unread: z.number(),
});

export type MailAddress = z.infer<typeof addressSchema>;
export type MessageSummary = z.infer<typeof messageSummarySchema>;
export type MessagesPage = z.infer<typeof messagesPageSchema>;
export type MailAttachment = z.infer<typeof attachmentSchema>;
export type MailMessage = z.infer<typeof mailMessageSchema>;
export type MailpitInfo = z.infer<typeof mailpitInfoSchema>;
