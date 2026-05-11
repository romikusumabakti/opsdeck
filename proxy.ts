import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

const intlMiddleware = createMiddleware(routing);

const PUBLIC_FIRST_SEGMENTS = new Set([
  "sign-in",
  "accept-invite",
  "setup",
  "forgot-password",
  "reset-password",
]);
const LOCALE_PREFIX_REGEX = new RegExp(
  `^/(${routing.locales.join("|")})(?=/|$)`
);

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // API routes and Next assets bypass i18n + auth checks here.
  if (pathname.startsWith("/api/") || pathname.startsWith("/_next/")) {
    return NextResponse.next();
  }

  // Strip optional locale prefix to match public paths regardless of locale.
  const stripped = pathname.replace(LOCALE_PREFIX_REGEX, "");
  const firstSegment = stripped.split("/")[1] ?? "";
  const isPublic = PUBLIC_FIRST_SEGMENTS.has(firstSegment);

  if (!isPublic) {
    const sessionCookie = getSessionCookie(req.headers);
    if (!sessionCookie) {
      const localeMatch = pathname.match(LOCALE_PREFIX_REGEX);
      const locale = localeMatch?.[1] ?? routing.defaultLocale;
      const url = req.nextUrl.clone();
      url.pathname = `/${locale}/sign-in`;
      // Pass redirect target without locale prefix so the client router can
      // re-add the user's current locale on the way back.
      url.searchParams.set("redirect", stripped || "/");
      return NextResponse.redirect(url);
    }
  }

  return intlMiddleware(req);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
