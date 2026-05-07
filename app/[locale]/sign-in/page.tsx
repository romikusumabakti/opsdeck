import { hasAnyUser } from "@/actions/users";
import { Copyright } from "@/components/copyright";
import { redirect } from "@/i18n/navigation";
import { getServerSession } from "@/lib/auth-session";
import { SignInForm } from "./sign-in-form";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const session = await getServerSession();
  const { redirect: redirectTo } = await searchParams;

  if (session) {
    await redirect(redirectTo || "/");
  }

  if (!(await hasAnyUser())) {
    await redirect("/setup");
  }

  return (
    <div className="min-h-screen flex flex-col p-4">
      <div className="flex-1 flex items-center justify-center">
        <SignInForm redirectTo={redirectTo} />
      </div>
      <Copyright className="pt-4" />
    </div>
  );
}
