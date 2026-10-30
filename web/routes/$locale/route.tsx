import {
  createFileRoute,
  type ErrorComponentProps,
  notFound,
  Outlet,
  useMatch,
} from "@tanstack/react-router";
import * as React from "react";
import { hasLocale } from "use-intl";
import { DialogProvider } from "@/components/dialog-provider";
import { NavigationGuardProvider } from "@/components/navigation-guard";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { applyBranding } from "@/i18n/branding";
import { persistLocale } from "@/i18n/locale-preference";
import { type Locale, locales } from "@/i18n/locales";
import { effectiveAccent } from "@/lib/accents";
import {
  bootstrapQuery,
  meQuery,
  useBootstrap,
  useMe,
} from "@/web/api/session";
import { authGate } from "@/web/auth-gate";
import { RootError, RootNotFound } from "@/web/components/fallback-screens";
import { IntlShell } from "@/web/components/intl-shell";
import {
  LocaleErrorContent,
  LocaleNotFoundContent,
} from "@/web/components/locale-fallbacks";
import { PendingScreen } from "@/web/components/pending-screen";
import {
  applyDocumentAccent,
  applyDocumentLocale,
} from "@/web/document-locale";
import { loadCatalogue } from "@/web/messages";

// Every page lives under `/<locale>`. This route owns what the old
// app/[locale]/layout.tsx did around both of its branches: reject an unknown
// locale, gate signed-out visitors, load the messages, set <html lang dir
// data-brand> and mount the providers every page shares. The signed-in shell
// is the pathless `_app` route below it; the sign-in, setup, password and
// invitation pages sit beside `_app` and frame themselves (AuthShell).
export const Route = createFileRoute("/$locale")({
  params: {
    parse: ({ locale }): { locale: Locale } => {
      if (!hasLocale(locales, locale)) throw notFound();
      return { locale };
    },
    stringify: ({ locale }) => ({ locale }),
  },
  // Runs on every navigation. `query()` answers from the cache while the
  // entry is younger than meQuery's staleTime and refetches `/api/me`
  // otherwise, so a session that died since is caught within a few seconds —
  // at once if an API call already got a 401, which clears the entry.
  beforeLoad: async ({ location, context: { queryClient } }) => {
    const me = await queryClient.query(meQuery());
    const redirect = authGate(location, me);
    if (redirect) throw redirect;
  },
  loader: async ({ params: { locale }, context: { queryClient } }) => {
    const [bootstrap, catalogue] = await Promise.all([
      queryClient.query(bootstrapQuery()),
      loadCatalogue(locale),
    ]);
    return { messages: applyBranding(catalogue, bootstrap) };
  },
  // The messages depend only on the locale (part of the match) and on the
  // branding, which is fixed per server process: load them once per locale
  // rather than re-walking the catalogue on every navigation.
  staleTime: Number.POSITIVE_INFINITY,
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData?.messages.app?.name }],
  }),
  component: LocaleLayout,
  errorComponent: LocaleError,
  notFoundComponent: LocaleNotFound,
  pendingComponent: PendingScreen,
});

function LocaleLayout() {
  const { locale } = Route.useParams();
  const { messages } = Route.useLoaderData();
  React.useEffect(() => {
    applyDocumentLocale(locale);
    // Entering a locale makes it the one a locale-less URL lands in, as
    // next-intl's middleware did.
    persistLocale(locale);
  }, [locale]);
  return (
    <IntlShell locale={locale} messages={messages}>
      <DocumentBrand />
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <DialogProvider>
          <NavigationGuardProvider>
            {/* A locale switch remounts the page, as the [locale] segment
                did under Next: state built from the old messages (a form's
                validation copy, an open menu) starts over in the new one. */}
            <Outlet key={locale} />
            <Toaster />
          </NavigationGuardProvider>
        </DialogProvider>
      </ThemeProvider>
    </IntlShell>
  );
}

// Logo shape and accent colour select CSS in web/styles.css through
// `data-brand` / `data-accent` on <html>. Signed in, the shell's
// AccentProvider owns the accent (it repaints at once on a change); signed
// out, the pages wear the brand's default.
function DocumentBrand() {
  const { brand } = useBootstrap();
  const me = useMe();
  React.useEffect(() => {
    document.documentElement.dataset.brand = brand;
  }, [brand]);
  React.useEffect(() => {
    if (!me) applyDocumentAccent(effectiveAccent(null, brand));
  }, [me, brand]);
  return null;
}

// The messages this route loaded, if it got that far. A boundary of this route
// renders in place of LocaleLayout, outside its IntlProvider, so it brings its
// own — or, when the loader itself failed, falls back to the English screens.
function useLoadedMessages() {
  const match = useMatch({ from: "/$locale", shouldThrow: false });
  if (!match?.loaderData) return null;
  return { locale: match.params.locale, messages: match.loaderData.messages };
}

// Port of app/[locale]/error.tsx.
function LocaleError(props: ErrorComponentProps) {
  const loaded = useLoadedMessages();
  if (!loaded) return <RootError {...props} />;
  return (
    <IntlShell locale={loaded.locale} messages={loaded.messages}>
      <LocaleErrorContent {...props} />
    </IntlShell>
  );
}

// Port of app/[locale]/not-found.tsx.
function LocaleNotFound() {
  const loaded = useLoadedMessages();
  if (!loaded) return <RootNotFound />;
  return (
    <IntlShell locale={loaded.locale} messages={loaded.messages}>
      <LocaleNotFoundContent />
    </IntlShell>
  );
}
