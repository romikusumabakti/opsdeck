import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins/admin";
import { v7 as uuidv7 } from "uuid";
import { APP_NAME, isAllowedEmail } from "./branding";
import { db } from "./db";
import {
  accounts,
  passkeys,
  sessions,
  users,
  verifications,
} from "./db/schema";
import { sendResetPasswordEmail } from "./email/send";
import { ROLE_ADMIN, ROLE_VIEWER } from "./roles";

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

const BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

// WebAuthn pins every credential to one Relying Party ID and one origin, and
// the browser refuses a ceremony whose rpID is not a registrable suffix of the
// page it runs on. Both are derived from BETTER_AUTH_URL instead of being
// separate env vars: an extra knob can only drift from the URL the app is
// actually served on, and the failure is quiet — registration succeeds and the
// credential is then never offered at sign-in.
const { hostname: RP_ID, origin: RP_ORIGIN } = new URL(BASE_URL);

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
  baseURL: BASE_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    usePlural: true,
    schema: {
      users,
      sessions,
      accounts,
      verifications,
      passkeys,
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
          // Unlike email/password, Microsoft sign-in DOES provision users:
          // whoever Entra lets through gets an account on first sign-in. The
          // access decision lives in Entra ("User assignment required" plus a
          // group), so we don't maintain a second list of who may enter.
          //
          // Two things keep that from being a hole:
          //   - the `databaseHooks` guard below rejects any email outside
          //     ALLOWED_EMAIL_DOMAIN, and
          //   - new users land on `defaultRole` (viewer — read-only), never
          //     with write or ops rights.
          // Invitations still exist for anyone who needs a higher role up front.
          disableSignUp: false,
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
      // A passkey ceremony is two requests (challenge, then verification) and
      // users retry after a cancelled prompt, so these sit above the password
      // limits — they still cap how fast a stolen credential id can be probed.
      "/passkey/generate-authenticate-options": { window: 60, max: 20 },
      "/passkey/verify-authentication": { window: 60, max: 20 },
      "/passkey/generate-register-options": { window: 60, max: 10 },
      "/passkey/verify-registration": { window: 60, max: 10 },
    },
  },
  databaseHooks: {
    user: {
      create: {
        // Last line of defence on who may exist at all. Runs for every user
        // creation path — /setup, invitation acceptance, and Microsoft
        // sign-in — so an Entra identity outside our email domain (a B2B
        // guest, or a second verified domain in the tenant) can never be
        // provisioned even if the Azure-side app assignment is misconfigured.
        //
        // Throwing (rather than returning false) is deliberate: better-auth
        // turns an APIError message into the `?error=` code on the OAuth
        // callback redirect, so the sign-in page can explain what happened
        // instead of showing a generic "unable to create user".
        before: async (user) => {
          if (!isAllowedEmail(user.email)) {
            throw APIError.from("FORBIDDEN", {
              message: "domain not allowed",
              code: "DOMAIN_NOT_ALLOWED",
            });
          }
        },
      },
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
      // The role for users nobody assigned one to — in practice only the
      // Microsoft sign-in path, which self-provisions. Read-only by design: a
      // fresh Entra identity can look around but cannot edit issues or KB
      // pages, let alone run ops. An admin promotes from the Users page.
      // Both server-action paths (/setup, invitation acceptance) pass an
      // explicit role, and the admin plugin's own hook spreads the incoming
      // user last, so this default never overrides them.
      defaultRole: ROLE_VIEWER,
      adminRoles: [ROLE_ADMIN],
    }),
    // Passkeys are an additional factor a user enrols from their account page —
    // never a sign-up path. Registration keeps the plugin's default of
    // requiring a session, so a passkey can only ever attach to a user who
    // already exists, and the domain and ban rules above therefore still hold:
    // the admin plugin's `session.create` hook rejects a banned user on the
    // passkey sign-in path exactly as it does on the password one.
    passkey({
      rpID: RP_ID,
      rpName: APP_NAME,
      origin: RP_ORIGIN,
      // Discoverable credentials, so sign-in works without typing an email
      // first — that is the whole point of the passkey button on /sign-in.
      // "preferred", not "required", so a security key with no room left for a
      // resident credential can still be enrolled as a second device.
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
