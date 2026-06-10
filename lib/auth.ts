import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins/admin";
import { v7 as uuidv7 } from "uuid";
import { APP_NAME } from "./branding";
import { db } from "./db";
import { accounts, sessions, users, verifications } from "./db/schema";
import { sendResetPasswordEmail } from "./email/send";
import { ROLE_ADMIN, ROLE_MEMBER } from "./roles";

const RESET_PASSWORD_TOKEN_TTL_SECONDS = 60 * 60;

// Fail fast in production rather than letting better-auth fall back to an
// ephemeral/insecure secret — that would silently invalidate every session on
// restart and weaken token signing.
if (process.env.NODE_ENV === "production" && !process.env.BETTER_AUTH_SECRET) {
  throw new Error("BETTER_AUTH_SECRET must be set in production");
}

export { ALLOWED_EMAIL_DOMAIN, isAllowedEmail } from "./branding";
export { ROLE_ADMIN, ROLE_MEMBER, type UserRole } from "./roles";

export const auth = betterAuth({
  appName: APP_NAME,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    usePlural: true,
    schema: {
      users,
      sessions,
      accounts,
      verifications,
    },
  }),
  emailAndPassword: {
    enabled: true,
    // No public sign-up — users are created only via invitation.
    disableSignUp: true,
    autoSignIn: false,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: RESET_PASSWORD_TOKEN_TTL_SECONDS,
    sendResetPassword: async ({ user, url }) => {
      await sendResetPasswordEmail(user.email, {
        recipientName: user.name || user.email,
        resetUrl: url,
        expiresInMinutes: Math.round(RESET_PASSWORD_TOKEN_TTL_SECONDS / 60),
      });
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
  },
  // Generate UUIDv7 for user/session/account/verification IDs so they are
  // time-ordered and friendly to B-tree indexes (matches our own tables).
  advanced: {
    database: {
      generateId: () => uuidv7(),
    },
  },
  plugins: [
    admin({
      defaultRole: ROLE_MEMBER,
      adminRoles: [ROLE_ADMIN],
    }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
