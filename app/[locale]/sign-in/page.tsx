import { hasAnyUser } from "@/actions/users";
import { Copyright } from "@/components/copyright";
import { redirect } from "@/i18n/navigation";
import { MICROSOFT_AUTH_ENABLED } from "@/lib/auth";
import { getServerSession } from "@/lib/auth-session";
import { SignInForm } from "./sign-in-form";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; error?: string }>;
}) {
  const session = await getServerSession();
  const { redirect: redirectTo, error } = await searchParams;

  if (session) {
    await redirect(redirectTo || "/");
  }

  if (!(await hasAnyUser())) {
    await redirect("/setup");
  }

  return (
    <div className="min-h-screen flex flex-col p-4">
      <div className="flex-1 flex items-center justify-center">
        <SignInForm
          redirectTo={redirectTo}
          microsoftEnabled={MICROSOFT_AUTH_ENABLED}
          oauthError={error}
        />
      </div>
      <Copyright className="pt-4" />
    </div>
  );
}
