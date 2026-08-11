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

const microsoftClientId = process.env.MICROSOFT_CLIENT_ID;
const microsoftClientSecret = process.env.MICROSOFT_CLIENT_SECRET;
const microsoftTenantId = process.env.MICROSOFT_TENANT_ID;

/**
 * Whether "Sign in with Microsoft" is wired up. Read this on the server (e.g.
 * the sign-in page) and pass it down — the credentials are server-only, so
 * there is no `NEXT_PUBLIC_` flag to check on the client.
 */
export const MICROSOFT_AUTH_ENABLED = Boolean(
  microsoftClientId && microsoftClientSecret && microsoftTenantId
);

// A tenant id is mandatory, not optional. Without it better-auth defaults to
// the "common" authority, which accepts ANY Microsoft account — and because we
// treat Microsoft as a trusted provider for account linking, a stranger whose
// personal Microsoft account happens to carry an invited user's email address
// could then link to (and sign in as) that user. Pinning the tenant restricts
// the flow to identities in our own directory.
if (
  process.env.NEXT_PHASE !== "phase-production-build" &&
  (microsoftClientId || microsoftClientSecret) &&
  !MICROSOFT_AUTH_ENABLED
) {
  throw new Error(
    "Microsoft sign-in is partially configured: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and MICROSOFT_TENANT_ID must all be set"
  );
}

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
  socialProviders: MICROSOFT_AUTH_ENABLED
    ? {
        microsoft: {
          clientId: microsoftClientId as string,
          clientSecret: microsoftClientSecret as string,
          tenantId: microsoftTenantId as string,
          // Same rule as email/password: no public sign-up. A Microsoft
          // identity can only sign in when a user with that email already
          // exists (created via /setup or an invitation); it is linked to that
          // user and never creates one. Unknown emails get redirected back to
          // /sign-in with `error=signup_disabled`.
          disableSignUp: true,
          // Entra hands back a Microsoft Graph photo URL that needs a bearer
          // token to fetch, so we can't render it in an <img>. Skip the call.
          disableProfilePhoto: true,
          // Don't silently reuse whatever account the browser is already
          // signed into on login.microsoftonline.com.
          prompt: "select_account",
        },
      }
    : undefined,
  account: {
    accountLinking: {
      enabled: true,
      // Entra doesn't emit `email_verified` unless the optional claim is
      // configured in the app registration, so without this a first Microsoft
      // sign-in by an existing user fails with `account_not_linked`. Trusting
      // it is safe here only because `tenantId` pins sign-in to our own
      // directory, which owns the addresses it asserts.
      trustedProviders: ["microsoft"],
      // A Microsoft identity may only attach to the user with the same email.
      allowDifferentEmails: false,
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
      "/sign-in/social": { window: 60, max: 10 },
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
