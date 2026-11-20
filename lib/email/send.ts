import { render } from "react-email";
import { getBranding } from "../instance-branding";
import { emailFrom, getResend } from "./client";
import {
  InvitationEmail,
  type InvitationEmailProps,
} from "./templates/invitation";
import {
  ResetPasswordEmail,
  type ResetPasswordEmailProps,
} from "./templates/reset-password";

export async function sendInvitationEmail(
  to: string,
  props: Omit<InvitationEmailProps, "appName">
) {
  const resend = getResend();
  const { name: appName } = await getBranding();
  const email = InvitationEmail({ ...props, appName });
  const html = await render(email);
  const text = await render(email, { plainText: true });

  const { error } = await resend.emails.send({
    from: await emailFrom(),
    to,
    subject: `Undangan ke ${appName}`,
    html,
    text,
  });

  if (error) {
    throw new Error(`Failed to send invitation email: ${error.message}`);
  }
}

export async function sendResetPasswordEmail(
  to: string,
  props: Omit<ResetPasswordEmailProps, "appName">
) {
  const resend = getResend();
  const { name: appName } = await getBranding();
  const email = ResetPasswordEmail({ ...props, appName });
  const html = await render(email);
  const text = await render(email, { plainText: true });

  const { error } = await resend.emails.send({
    from: await emailFrom(),
    to,
    subject: `Reset kata sandi ${appName}`,
    html,
    text,
  });

  if (error) {
    throw new Error(`Failed to send reset password email: ${error.message}`);
  }
}
