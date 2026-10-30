import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { getServerSession } from "../lib/auth-session";
import { effectiveTimeZone } from "../lib/timezone";
import { applyBranding } from "./branding";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  const raw = (await import(`../messages/${locale}.json`)).default;
  return {
    locale,
    messages: applyBranding(raw),
    // The reader's own zone. getServerSession is request-memoised, so this
    // adds no query on pages that already read the session.
    timeZone: effectiveTimeZone((await getServerSession())?.user),
  };
});
