"use server";

import { randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getLocale, getTranslations } from "next-intl/server";
import { ALLOWED_EMAIL_DOMAIN, auth, isAllowedEmail } from "@/lib/auth";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { invitations, users as userTable } from "@/lib/db/schema";
import { sendInvitationEmail } from "@/lib/email/send";

export type ActionResponse =
  | { success: true; message?: string }
  | { success: false; message: string };

const INVITE_EXPIRES_HOURS = 48;

/**
 * Returns true when there is at least one user in the database. Used by the
 * /setup page to decide whether the initial-user form should be shown.
 */
export async function hasAnyUser(): Promise<boolean> {
  const [row] = await db.select({ value: count() }).from(userTable);
  return (row?.value ?? 0) > 0;
}

/**
 * Bootstrap action: create the very first user without an invitation. Refuses
 * if any user already exists (so the endpoint is harmless after setup).
 */
export async function createInitialUser(input: {
  name: string;
  email: string;
  password: string;
}): Promise<ActionResponse> {
  const t = await getTranslations("actionErrors");

  if (await hasAnyUser()) {
    return { success: false, message: t("setupAlreadyDone") };
  }

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

  const hash = await ctx.password.hash(input.password);

  const created = await ctx.internalAdapter.createUser({
    name,
    email,
    emailVerified: true,
    image: null,
  });

  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    accountId: created.id,
    providerId: "credential",
    password: hash,
  });

  revalidatePath("/", "layout");
  return { success: true, message: t("accountCreated") };
}

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
  const expiresAt = new Date(
    Date.now() + INVITE_EXPIRES_HOURS * 60 * 60 * 1000
  );

  await db
    .delete(invitations)
    .where(and(eq(invitations.email, email), isNull(invitations.acceptedAt)));

  await db.insert(invitations).values({
    // id defaults to uuidv7() in DB
    email,
    name,
    token,
    invitedById: session.user.id,
    expiresAt,
  });

  const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  // Inherit the inviter's current locale so the recipient lands on the same
  // language they were invited in.
  const locale = await getLocale();
  const inviteUrl = `${baseUrl}/${locale}/accept-invite/${token}`;

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
