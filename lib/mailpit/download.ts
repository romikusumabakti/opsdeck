import { MailpitError } from "./client";

// Same encoding as the explorer download route. Always `attachment`: email
// parts are attacker-controlled, so they must never render on our origin.
export function attachmentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Forced octet-stream for the same reason: nothing from an email is ever
// sniffed or rendered as HTML/SVG by the browser.
export const DOWNLOAD_HEADERS = {
  "Content-Type": "application/octet-stream",
  "Cache-Control": "private, no-store",
} as const;

export function mailpitErrorResponse(err: unknown): Response {
  if (err instanceof MailpitError) {
    return new Response(err.message, {
      status: err.status === 404 ? 404 : 502,
    });
  }
  console.error("Mailpit download failed:", err);
  return new Response("Download failed", { status: 500 });
}
