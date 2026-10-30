import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// The password form lives on the account page's security tab.
export const Route = createFileRoute("/$locale/_app/account/change-password")({
  beforeLoad: ({ params: { locale } }) => {
    redirect("/account?tab=security", locale);
  },
});
