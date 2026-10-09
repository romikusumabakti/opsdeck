import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins/admin";
import { eq } from "drizzle-orm";
import { after } from "next/server";
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
import { MICROSOFT_AUTH_ENABLED } from "./env";
import { nameTaken, pickFreeName } from "./people/names";
import { orgAc, orgRoles } from "./permissions";
import { uuidSchema } from "./validation";

const RESET_PASSWORD_TOKEN_TTL_SECONDS = 60 * 60;

export { ALLOWED_EMAIL_DOMAIN, isAllowedEmail } from "./branding";
// Re-exported so the sign-in page keeps importing it from here; the flag and
// the "all three or none" rule that protects it now live in lib/env, which
// checks them at boot alongside every other var (see validateEnv).
export { MICROSOFT_AUTH_ENABLED } from "./env";
export type { OrgRole } from "./permissions";

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
          //   - new users land on `defaultRole` (member — no projects until added), never
          //     with write or ops rights.
          // Invitations still exist for anyone who needs a higher role up front.
          disableSignUp: false,
          // Entra hands back a Graph photo URL that needs a bearer token, so
          // better-auth can't store a usable `image`. lib/avatars-microsoft
          // copies the photo into our own store after sign-in instead.
          disableProfilePhoto: true,
          // Don't silently reuse whatever account the browser is already
          // signed into on login.microsoftonline.com.
          prompt: "select_account",
        },
      }
    : undefined,
  user: {
    // Profile fields ride on the session (the layout needs timezone and
    // status on every render) but are written only by actions/profile.ts,
    // never through /update-user, hence input: false.
    additionalFields: {
      title: { type: "string", required: false, input: false },
      bio: { type: "string", required: false, input: false },
      timezone: { type: "string", required: false, input: false },
      workingHours: { type: "json", required: false, input: false },
      statusEmoji: { type: "string", required: false, input: false },
      statusText: { type: "string", required: false, input: false },
      statusExpiresAt: { type: "date", required: false, input: false },
      avatarSource: { type: "string", required: false, input: false },
    },
  },
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
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Name and image are written only by actions/profile.ts and
      // lib/avatars, which validate, keep names unique and only ever store
      // our own /api/avatars URL. better-auth's generic user-update endpoints
      // would bypass all of that (`input: false` guards only our additional
      // fields), and nothing in the app calls them, so they are closed.
      if (ctx.path === "/update-user" || ctx.path === "/admin/update-user") {
        throw APIError.from("FORBIDDEN", {
          message: "Profile changes go through the account page.",
          code: "profile_update_forbidden",
        });
      }
      // Names are unique among active users only, so a deactivated user's
      // name may have been reused since. Reactivating them would trip the
      // unique index with an opaque 500; refuse with a reason instead.
      if (ctx.path === "/admin/unban-user") {
        const parsed = uuidSchema.safeParse(
          (ctx.body as { userId?: unknown } | undefined)?.userId
        );
        // Malformed ids are left to the endpoint's own validation.
        if (!parsed.success) return;
        const userId = parsed.data;
        const [target] = await db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (target && (await nameTaken(target.name, userId))) {
          throw APIError.from("CONFLICT", {
            message:
              "Another active user has this name. Rename one of them first.",
            code: "name_taken",
          });
        }
      }
    }),
    // After a Microsoft sign-in, pull the M365 photo in the background.
    // after() runs it once the response is sent, so sign-in never waits on
    // Graph, and a failure only logs. Dynamic import: lib/avatars-microsoft
    // imports this module.
    after: createAuthMiddleware(async (ctx) => {
      if (!ctx.path.startsWith("/callback") || ctx.params?.id !== "microsoft")
        return;
      const userId = ctx.context.newSession?.user.id;
      if (!userId) return;
      after(async () => {
        const { importMicrosoftAvatar } = await import(
          "@/lib/avatars-microsoft"
        );
        await importMicrosoftAvatar(userId).catch((error) =>
          console.error("Microsoft avatar import failed:", error)
        );
      });
    }),
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
        // passes an APIError's `code` through verbatim as the `?error=` value
        // on the OAuth callback redirect, so the sign-in page can explain what
        // happened instead of showing a generic "unable to create user". The
        // code is therefore the lowercase slug sign-in-form.tsx matches on.
        before: async (user) => {
          if (!isAllowedEmail(user.email)) {
            throw APIError.from("FORBIDDEN", {
              message: "domain not allowed",
              code: "domain_not_allowed",
            });
          }
          // A clashing display name must never block a sign-in or an invite.
          return {
            data: { ...user, name: await pickFreeName(user.name, user.email) },
          };
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
      // Roles and their statements live in lib/permissions. A user nobody
      // assigned a role to — in practice a fresh Microsoft sign-in — lands on
      // `member`: with project isolation that is the knowledge base and zero
      // projects until an admin adds memberships.
      ac: orgAc,
      roles: orgRoles,
      defaultRole: "member",
      adminRoles: ["admin"],
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
