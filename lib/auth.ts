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
// restart and weaken token signing. Skip during `next build`: page-data
// collection evaluates this module with NODE_ENV=production but no runtime env,
// and the secret is only needed when actually serving requests.
if (
  process.env.NEXT_PHASE !== "phase-production-build" &&
  process.env.NODE_ENV === "production" &&
  !process.env.BETTER_AUTH_SECRET
) {
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
  // Throttle client-initiated auth requests to blunt brute-force and token
  // enumeration. Server-side `auth.api` calls are exempt. Storage is in-memory
  // (the app runs as a single standalone instance); switch to the database
  // adapter if scaled horizontally so counters are shared across replicas.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/forget-password": { window: 60, max: 3 },
      "/request-password-reset": { window: 60, max: 3 },
      "/reset-password": { window: 60, max: 5 },
    },
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
