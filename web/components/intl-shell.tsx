import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import type { Locale } from "@/i18n/locales";
import { bootstrapQuery, meQuery } from "@/web/api/session";
import type { Messages } from "@/web/messages";

/**
 * The i18n context for everything under `/<locale>`. Dates format in the
 * reader's own zone — `/api/me`'s `timeZone`, which the server resolves with
 * effectiveTimeZone() — and, signed out, in the app's zone from bootstrap,
 * as next-intl's request config did.
 */
export function IntlShell({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: ReactNode;
}) {
  // Both are already cached by the $locale loader; plain useQuery (not
  // suspense) so an error screen rendering this can never suspend or throw.
  const me = useQuery(meQuery()).data;
  const bootstrap = useQuery(bootstrapQuery()).data;
  return (
    <IntlProvider
      locale={locale}
      messages={messages}
      timeZone={me?.timeZone ?? bootstrap?.appTimeZone}
    >
      {children}
    </IntlProvider>
  );
}
