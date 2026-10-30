import { createFileRoute, redirect } from "@tanstack/react-router";
import { defaultLocale } from "@/i18n/locales";

// Every page lives under a locale; the bare root goes to the default one.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({
      to: "/$locale",
      params: { locale: defaultLocale },
      replace: true,
    });
  },
});
