import { redirect } from "next/navigation";
import { hasAnyUser } from "@/actions/users";
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
    redirect(redirectTo || "/");
  }

  if (!(await hasAnyUser())) {
    redirect("/setup");
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <SignInForm redirectTo={redirectTo} />
    </div>
  );
}
