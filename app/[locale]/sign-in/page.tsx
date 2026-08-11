import { getTranslations } from "next-intl/server";
import { hasAnyUser } from "@/actions/users";
import { AuthShell } from "@/components/auth-shell";
import { redirect } from "@/i18n/navigation";
import { MICROSOFT_AUTH_ENABLED } from "@/lib/auth";
import { getServerSession } from "@/lib/auth-session";
import { safeRedirect } from "@/lib/safe-redirect";
import { SignInForm } from "./sign-in-form";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; error?: string }>;
}) {
  const session = await getServerSession();
  const { redirect: rawRedirect, error } = await searchParams;

  // Sanitised here rather than in the client so an attacker-supplied absolute
  // URL never reaches `router.push()` or the OAuth `callbackURL`.
  const redirectTo = safeRedirect(rawRedirect);

  if (session) {
    await redirect(redirectTo);
  }

  if (!(await hasAnyUser())) {
    await redirect("/setup");
  }

  const t = await getTranslations("signIn");

  return (
    <AuthShell title={t("title")} description={t("description")}>
      <SignInForm
        redirectTo={redirectTo}
        microsoftEnabled={MICROSOFT_AUTH_ENABLED}
        oauthError={error}
      />
    </AuthShell>
  );
}
