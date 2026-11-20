import { Resend } from "resend";
import { defaultEmailFrom } from "../branding";
import { getBranding } from "../instance-branding";

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

/** EMAIL_FROM, or `<instance name> <no-reply@ALLOWED_EMAIL_DOMAIN>`. */
export async function emailFrom(): Promise<string> {
  const configured = process.env.EMAIL_FROM;
  if (configured) return configured;
  return defaultEmailFrom((await getBranding()).name);
}
