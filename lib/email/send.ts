import { render } from "@react-email/render";
import { getFromAddress, getResend } from "./client";
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
  props: InvitationEmailProps
) {
  const resend = getResend();
  const html = await render(InvitationEmail(props));
  const text = await render(InvitationEmail(props), { plainText: true });

  const { error } = await resend.emails.send({
    from: getFromAddress(),
    to,
    subject: "Undangan ke Admin Panel",
    html,
    text,
  });

  if (error) {
    throw new Error(`Failed to send invitation email: ${error.message}`);
  }
}

export async function sendResetPasswordEmail(
  to: string,
  props: ResetPasswordEmailProps
) {
  const resend = getResend();
  const html = await render(ResetPasswordEmail(props));
  const text = await render(ResetPasswordEmail(props), { plainText: true });

  const { error } = await resend.emails.send({
    from: getFromAddress(),
    to,
    subject: "Reset kata sandi Admin Panel",
    html,
    text,
  });

  if (error) {
    throw new Error(`Failed to send reset password email: ${error.message}`);
  }
}
