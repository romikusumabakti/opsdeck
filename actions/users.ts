"use server";

import { auth, isAllowedEmail, ALLOWED_EMAIL_DOMAIN } from "@/lib/auth";
import { db } from "@/lib/db";
import { invitations, users as userTable } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-session";
import { sendInvitationEmail } from "@/lib/email/send";
import { and, eq, isNull, gt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { getTranslations } from "next-intl/server";

export type ActionResponse =
  | { success: true; message?: string }
  | { success: false; message: string };

const INVITE_EXPIRES_HOURS = 48;

export async function listUsers() {
  await requireSession();
  return db
    .select({
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
      emailVerified: userTable.emailVerified,
      image: userTable.image,
      createdAt: userTable.createdAt,
    })
    .from(userTable)
    .orderBy(userTable.createdAt);
}

export async function listPendingInvitations() {
  await requireSession();
  const now = new Date();
  return db
    .select()
    .from(invitations)
    .where(and(isNull(invitations.acceptedAt), gt(invitations.expiresAt, now)))
    .orderBy(invitations.createdAt);
}

export async function inviteUser(input: {
  email: string;
  name: string;
}): Promise<ActionResponse> {
  const session = await requireSession();
  const t = await getTranslations("actionErrors");

  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();

  if (!email || !name) {
    return { success: false, message: t("nameAndEmailRequired") };
  }
  if (!isAllowedEmail(email)) {
    return {
      success: false,
      message: t("domainNotAllowed", { domain: ALLOWED_EMAIL_DOMAIN }),
    };
  }

  const existing = await db
    .select()
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1);

  if (existing.length > 0) {
    return { success: false, message: t("emailAlreadyRegistered") };
  }

  const token = randomBytes(32).toString("hex");
  const id = randomBytes(12).toString("hex");
  const expiresAt = new Date(
    Date.now() + INVITE_EXPIRES_HOURS * 60 * 60 * 1000
  );

  await db
    .delete(invitations)
    .where(and(eq(invitations.email, email), isNull(invitations.acceptedAt)));

  await db.insert(invitations).values({
    id,
    email,
    name,
    token,
    invitedById: session.user.id,
    expiresAt,
  });

  const baseUrl =
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const inviteUrl = `${baseUrl}/accept-invite/${token}`;

  try {
    await sendInvitationEmail(email, {
      recipientName: name,
      inviterName: session.user.name,
      inviteUrl,
      expiresInHours: INVITE_EXPIRES_HOURS,
    });
  } catch (err) {
    console.error("Failed to send invitation email:", err);
    return { success: false, message: t("emailSendFailed") };
  }

  revalidatePath("/users");
  return { success: true, message: t("emailSent") };
}

export async function deleteUser(userId: string): Promise<ActionResponse> {
  const session = await requireSession();
  const t = await getTranslations("actionErrors");

  if (session.user.id === userId) {
    return { success: false, message: t("cannotDeleteSelf") };
  }

  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteUser(userId);

  revalidatePath("/users");
  return { success: true, message: t("userDeleted") };
}

export async function revokeInvitation(
  invitationId: string
): Promise<ActionResponse> {
  await requireSession();
  const t = await getTranslations("actionErrors");
  await db.delete(invitations).where(eq(invitations.id, invitationId));
  revalidatePath("/users");
  return { success: true, message: t("invitationRevoked") };
}

/**
 * Verify an invitation token and return the invitation if it is still valid.
 * Used by the accept-invite page (no auth required).
 */
export async function getInvitationByToken(token: string) {
  const now = new Date();
  const [row] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .limit(1);

  if (!row) return null;
  if (row.acceptedAt) return null;
  if (row.expiresAt < now) return null;
  return row;
}

export async function acceptInvitation(input: {
  token: string;
  password: string;
}): Promise<ActionResponse> {
  const t = await getTranslations("actionErrors");

  const inv = await getInvitationByToken(input.token);
  if (!inv) {
    return { success: false, message: t("invitationInvalid") };
  }

  if (!isAllowedEmail(inv.email)) {
    return {
      success: false,
      message: t("domainNotAllowed", { domain: ALLOWED_EMAIL_DOMAIN }),
    };
  }

  const ctx = await auth.$context;

  if (input.password.length < ctx.password.config.minPasswordLength) {
    return {
      success: false,
      message: t("passwordTooShort", {
        min: ctx.password.config.minPasswordLength,
      }),
    };
  }
  if (input.password.length > ctx.password.config.maxPasswordLength) {
    return {
      success: false,
      message: t("passwordTooLong", {
        max: ctx.password.config.maxPasswordLength,
      }),
    };
  }

  const existing = await ctx.internalAdapter.findUserByEmail(inv.email);
  if (existing?.user) {
    return { success: false, message: t("emailAlreadyRegistered") };
  }

  const hash = await ctx.password.hash(input.password);

  const created = await ctx.internalAdapter.createUser({
    name: inv.name,
    email: inv.email,
    emailVerified: true,
    image: null,
  });

  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    accountId: created.id,
    providerId: "credential",
    password: hash,
  });

  await db
    .update(invitations)
    .set({ acceptedAt: new Date() })
    .where(eq(invitations.id, inv.id));

  return { success: true, message: t("accountCreated") };
}
