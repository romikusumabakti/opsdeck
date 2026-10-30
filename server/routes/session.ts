import { getServerSession } from "@/lib/auth-session";
import {
  ALLOWED_EMAIL_DOMAIN,
  APP_NAME,
  brand,
  COMPANY_NAME,
} from "@/lib/branding";
import { MICROSOFT_AUTH_ENABLED } from "@/lib/env";
import { normalizeOrgRole } from "@/lib/permissions";
import { effectiveTimeZone } from "@/lib/timezone";
import { publicRouter } from "@/server/router";

/**
 * What the SPA needs before it can render anything, mounted at /api. Both are
 * public: the sign-in page renders while signed out, and `/api/me` is how the
 * client finds out that it is.
 */
export const sessionInfoRouter = publicRouter()
  // Deployment identity, read from the server env at runtime (the client
  // bundle is built without it). `microsoftSignIn` shows the Microsoft button
  // on the sign-in page — true only when all three MICROSOFT_* vars are set.
  .get("/bootstrap", (c) =>
    c.json({
      appName: APP_NAME,
      companyName: COMPANY_NAME,
      allowedEmailDomain: ALLOWED_EMAIL_DOMAIN,
      brand: brand(),
      microsoftSignIn: MICROSOFT_AUTH_ENABLED,
    })
  )
  // The signed-in user, or null (200, not 401): being signed out is an answer
  // here, not an error. Never cached — it changes on sign-in and sign-out.
  .get("/me", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const session = await getServerSession();
    if (!session) return c.json(null);
    return c.json({
      user: session.user,
      orgRole: normalizeOrgRole(session.user.role),
      timeZone: effectiveTimeZone(session.user),
    });
  });
