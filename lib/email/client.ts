import { Resend } from "resend";
import { DEFAULT_EMAIL_FROM } from "../branding";

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
  return process.env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM;
}
