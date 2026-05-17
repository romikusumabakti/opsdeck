"use server";

import { randomBytes } from "node:crypto";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getLocale, getTranslations } from "next-intl/server";
import {
  ALLOWED_EMAIL_DOMAIN,
  auth,
  isAllowedEmail,
  ROLE_ADMIN,
  ROLE_MEMBER,
  type UserRole,
} from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-session";
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

  // The bootstrap user owns the panel — promote to admin so they can manage
  // users/servers. Subsequent users are created as "member" via invitation.
  const created = await ctx.internalAdapter.createUser({
    name,
    email,
    emailVerified: true,
    image: null,
    role: ROLE_ADMIN,
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
  await requireAdmin();
  return db
    .select({
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
      emailVerified: userTable.emailVerified,
      image: userTable.image,
      role: userTable.role,
      createdAt: userTable.createdAt,
    })
    .from(userTable)
    .orderBy(userTable.createdAt);
}

export async function listPendingInvitations() {
  await requireAdmin();
  // Include expired invitations too — admins should be able to see them and
  // either resend or revoke. The UI flags expired rows with a badge.
  return db
    .select()
    .from(invitations)
    .where(isNull(invitations.acceptedAt))
    .orderBy(invitations.createdAt);
}

export async function inviteUser(input: {
  email: string;
  name: string;
  role: UserRole;
}): Promise<ActionResponse> {
  const session = await requireAdmin();
  const t = await getTranslations("actionErrors");

  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const role: UserRole = input.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_MEMBER;

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
    role,
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

export async function updateUserName(input: {
  userId: string;
  name: string;
}): Promise<ActionResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");

  const name = input.name.trim();
  if (!name) {
    return { success: false, message: t("nameRequired") };
  }
  if (name.length > 100) {
    return { success: false, message: t("nameTooLong") };
  }

  const result = await db
    .update(userTable)
    .set({ name, updatedAt: new Date() })
    .where(eq(userTable.id, input.userId))
    .returning({ id: userTable.id });

  if (result.length === 0) {
    return { success: false, message: t("errorGeneric") };
  }

  revalidatePath("/users");
  return { success: true, message: t("nameUpdated") };
}

export async function updateUserRole(input: {
  userId: string;
  role: UserRole;
}): Promise<ActionResponse> {
  const session = await requireAdmin();
  const t = await getTranslations("actionErrors");

  if (session.user.id === input.userId) {
    return { success: false, message: t("cannotChangeOwnRole") };
  }

  const role: UserRole = input.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_MEMBER;

  // Direct Drizzle update: the admin plugin's `setRole` API only accepts its
  // built-in role names in TypeScript types, but our `member` role is custom.
  // Updating our own users table avoids that mismatch and is what `setRole`
  // does internally anyway.
  const result = await db
    .update(userTable)
    .set({ role, updatedAt: new Date() })
    .where(eq(userTable.id, input.userId))
    .returning({ id: userTable.id });

  if (result.length === 0) {
    return { success: false, message: t("errorGeneric") };
  }

  revalidatePath("/users");
  return { success: true, message: t("roleUpdated") };
}

export async function deleteUser(userId: string): Promise<ActionResponse> {
  const session = await requireAdmin();
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
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  await db.delete(invitations).where(eq(invitations.id, invitationId));
  revalidatePath("/users");
  return { success: true, message: t("invitationRevoked") };
}

export async function resendInvitation(
  invitationId: string
): Promise<ActionResponse> {
  const session = await requireAdmin();
  const t = await getTranslations("actionErrors");

  const [inv] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.id, invitationId))
    .limit(1);

  if (!inv || inv.acceptedAt) {
    return { success: false, message: t("invitationInvalid") };
  }

  const existing = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, inv.email))
    .limit(1);

  if (existing.length > 0) {
    return { success: false, message: t("emailAlreadyRegistered") };
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(
    Date.now() + INVITE_EXPIRES_HOURS * 60 * 60 * 1000
  );

  await db
    .update(invitations)
    .set({ token, expiresAt })
    .where(eq(invitations.id, invitationId));

  const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const locale = await getLocale();
  const inviteUrl = `${baseUrl}/${locale}/accept-invite/${token}`;

  try {
    await sendInvitationEmail(inv.email, {
      recipientName: inv.name,
      inviterName: session.user.name,
      inviteUrl,
      expiresInHours: INVITE_EXPIRES_HOURS,
    });
  } catch (err) {
    console.error("Failed to resend invitation email:", err);
    return { success: false, message: t("emailSendFailed") };
  }

  revalidatePath("/users");
  return { success: true, message: t("emailSent") };
}

export type BulkUsersResult =
  | {
      success: true;
      deleted: number;
      skippedSelf: boolean;
      failed: { id: string; message: string }[];
    }
  | { success: false; message: string };

/**
 * Bulk-delete users. Skips the caller's own account (UI prevents selecting
 * self, but enforce on the server too — a tampered client could still POST
 * its own ID). Partial success is allowed: one failure doesn't block the
 * rest, matching the bulk-servers behavior.
 */
export async function bulkDeleteUsers(ids: string[]): Promise<BulkUsersResult> {
  const session = await requireAdmin();
  const t = await getTranslations("actionErrors");

  const targets = ids.filter((id) => id !== session.user.id);
  const skippedSelf = targets.length !== ids.length;

  if (targets.length === 0) {
    revalidatePath("/users");
    return { success: true, deleted: 0, skippedSelf, failed: [] };
  }

  const ctx = await auth.$context;
  let deleted = 0;
  const failed: { id: string; message: string }[] = [];
  for (const id of targets) {
    try {
      await ctx.internalAdapter.deleteUser(id);
      deleted += 1;
    } catch (error) {
      console.error(`Failed to delete user ${id}:`, error);
      failed.push({ id, message: t("errorGeneric") });
    }
  }
  revalidatePath("/users");
  return { success: true, deleted, skippedSelf, failed };
}

export type BulkInvitationsResult =
  | { success: true; revoked: number }
  | { success: false; message: string };

export async function bulkRevokeInvitations(
  ids: string[]
): Promise<BulkInvitationsResult> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  if (ids.length === 0) {
    return { success: true, revoked: 0 };
  }
  try {
    const result = await db
      .delete(invitations)
      .where(inArray(invitations.id, ids))
      .returning({ id: invitations.id });
    revalidatePath("/users");
    return { success: true, revoked: result.length };
  } catch (error) {
    console.error("Failed to bulk-revoke invitations:", error);
    return { success: false, message: t("errorGeneric") };
  }
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

  // Promote per the invitation's stored role. Validate against known roles
  // in case the row was tampered with directly in the DB.
  const role: UserRole = inv.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_MEMBER;

  const created = await ctx.internalAdapter.createUser({
    name: inv.name,
    email: inv.email,
    emailVerified: true,
    image: null,
    role,
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
