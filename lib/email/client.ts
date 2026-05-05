import { Resend } from "resend";

let _resend: Resend | null = null;

export function getResend(): Resend {
  if (_resend) return _resend;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  _resend = new Resend(apiKey);
  return _resend;
}

export function getFromAddress(): string {
  return process.env.EMAIL_FROM ?? "Admin Panel <no-reply@example.com>";
}
