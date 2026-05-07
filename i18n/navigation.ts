import { createNavigation } from "next-intl/navigation";
import { getLocale } from "next-intl/server";
import { routing } from "./routing";

const nav = createNavigation(routing);

export const { Link, usePathname, useRouter, getPathname } = nav;

/**
 * Server-side redirect that automatically picks up the current request's
 * locale. Use this from server components, layouts, and server actions
 * instead of `redirect` from `next/navigation` so the URL keeps its
 * `/<locale>/` prefix.
 */
export async function redirect(href: string): Promise<never> {
  const locale = await getLocale();
  nav.redirect({ href, locale });
  throw new Error("redirect did not throw");
}
