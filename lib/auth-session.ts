import { headers } from "next/headers";
import { redirect } from "@/i18n/navigation";
import { auth } from "./auth";

export async function getServerSession() {
  return auth.api.getSession({
    headers: await headers(),
  });
}

export async function requireSession() {
  const session = await getServerSession();
  if (!session) {
    // Proxy only checks cookie presence; a stale cookie reaches here.
    await redirect("/sign-in");
  }
  return session;
}
