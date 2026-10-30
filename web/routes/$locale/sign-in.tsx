import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { AuthShell } from "@/components/auth-shell";
import { redirect } from "@/i18n/navigation";
import { safeRedirect } from "@/lib/safe-redirect";
import { meQuery, useBootstrap } from "@/web/api/session";
import { hasAnyUserQuery } from "@/web/api/users";
import { isPublicPath } from "@/web/auth-gate";
import { SignInForm } from "./-components/sign-in-form";

export const Route = createFileRoute("/$locale/sign-in")({
  // `redirect` is the page to return to, without its locale (see
  // web/auth-gate.ts). It comes from the URL, so it is sanitised here:
  // `//evil.example` would otherwise survive localizeHref as a
  // protocol-relative URL and turn sign-in into an open redirect — and an
  // absolute URL would reach the OAuth `callbackURL`. `error` is the code
  // better-auth appends when a Microsoft sign-in bounces back. A target that
  // is itself a signed-out page (`/sign-in`, `/setup`, …) is dropped too: a
  // signed-in visitor is sent on to it, and sign-in would send them back.
  validateSearch: (
    search: Record<string, unknown>
  ): { redirect?: string; error?: string } => {
    const raw = typeof search.redirect === "string" ? search.redirect : "";
    const safe = safeRedirect(raw, "");
    const redirect = safe && !isPublicPath(safe) ? safe : "";
    const error = typeof search.error === "string" ? search.error : undefined;
    return { redirect: redirect || undefined, error };
  },
  // Already signed in: straight on to the page they came for. No account
  // exists yet: the first one is made on /setup.
  beforeLoad: async ({
    params: { locale },
    search,
    context: { queryClient },
  }) => {
    if (await queryClient.query(meQuery())) {
      redirect(search.redirect || "/", locale);
    }
    if (!(await queryClient.query(hasAnyUserQuery()))) {
      redirect("/setup", locale);
    }
  },
  component: SignInPage,
});

function SignInPage() {
  const t = useTranslations("signIn");
  const { redirect, error } = Route.useSearch();
  const { microsoftSignIn } = useBootstrap();
  return (
    <AuthShell title={t("title")} description={t("description")}>
      <SignInForm
        redirectTo={redirect}
        microsoftEnabled={microsoftSignIn}
        oauthError={error}
      />
    </AuthShell>
  );
}
