import {
  createFileRoute,
  type ErrorComponentProps,
  notFound,
  Outlet,
  useMatch,
  useRouter,
} from "@tanstack/react-router";
import { AlertTriangle, FileQuestion, Home, RotateCcw } from "lucide-react";
import * as React from "react";
import { hasLocale, useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { applyBranding } from "@/i18n/branding";
import { type Locale, locales } from "@/i18n/locales";
import { Link } from "@/i18n/navigation";
import { bootstrapQuery, meQuery } from "@/web/api/session";
import { authGate } from "@/web/auth-gate";
import { RootError, RootNotFound } from "@/web/components/fallback-screens";
import { IntlShell } from "@/web/components/intl-shell";
import { PendingScreen } from "@/web/components/pending-screen";
import { applyDocumentLocale } from "@/web/document-locale";
import { loadCatalogue } from "@/web/messages";

// Every page lives under `/<locale>`. This route owns what the old
// app/[locale]/layout.tsx did before rendering the shell: reject an unknown
// locale, gate signed-out visitors, load the messages and set <html lang dir>.
export const Route = createFileRoute("/$locale")({
  params: {
    parse: ({ locale }): { locale: Locale } => {
      if (!hasLocale(locales, locale)) throw notFound();
      return { locale };
    },
    stringify: ({ locale }) => ({ locale }),
  },
  // Runs on every navigation, so a session that died since the last page is
  // caught on the next one. `/api/me` comes from the cache when fresh.
  beforeLoad: async ({ location, context: { queryClient } }) => {
    const me = await queryClient.ensureQueryData(meQuery());
    const redirect = authGate(location, me);
    if (redirect) throw redirect;
  },
  loader: async ({ params: { locale }, context: { queryClient } }) => {
    const [, bootstrap, catalogue] = await Promise.all([
      queryClient.ensureQueryData(meQuery()),
      queryClient.ensureQueryData(bootstrapQuery()),
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
  }, [locale]);
  return (
    <IntlShell locale={locale} messages={messages}>
      <Outlet />
    </IntlShell>
  );
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

function LocaleErrorContent({ error, reset }: ErrorComponentProps) {
  const t = useTranslations("common");
  const router = useRouter();
  const message = error instanceof Error ? error.message : "";

  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center py-12">
      <div className="flex flex-col items-center gap-4 text-center max-w-md">
        <div className="size-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center">
          <AlertTriangle className="size-6" />
        </div>
        <h1 className="text-xl font-semibold">{t("errorTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("errorDescription")}</p>
        {message && (
          <div className="w-full rounded-md border bg-muted/40 px-3 py-2 text-start">
            <span className="text-xs font-medium text-muted-foreground">
              {t("errorDetails")}
            </span>
            <p className="mt-0.5 font-mono text-xs text-foreground/80 break-words">
              {message}
            </p>
          </div>
        )}
        <div className="flex flex-col-reverse sm:flex-row gap-2 mt-2">
          <Button render={<Link href="/" />} variant="outline">
            <Home className="size-4" />
            {t("backToHome")}
          </Button>
          <Button
            onClick={() => {
              // reset() clears the boundary; invalidate() re-runs the
              // loaders that threw.
              reset();
              void router.invalidate();
            }}
          >
            <RotateCcw className="size-4" />
            {t("tryAgain")}
          </Button>
        </div>
      </div>
    </div>
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

function LocaleNotFoundContent() {
  const t = useTranslations("common");
  return (
    <div className="flex flex-1 items-center justify-center py-12">
      <div className="flex flex-col items-center gap-4 text-center max-w-md">
        <div className="size-12 rounded-full bg-muted text-muted-foreground flex items-center justify-center">
          <FileQuestion className="size-6" />
        </div>
        <h1 className="text-xl font-semibold">{t("notFoundTitle")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("notFoundDescription")}
        </p>
        <Button render={<Link href="/" />} className="mt-2">
          <Home className="size-4" />
          {t("backToHome")}
        </Button>
      </div>
    </div>
  );
}
