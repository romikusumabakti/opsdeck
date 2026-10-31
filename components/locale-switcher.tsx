import { Languages } from "lucide-react";
import { useTransition } from "react";
import { useLocale, useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipHint } from "@/components/ui/tooltip";
import { persistLocale } from "@/i18n/locale-preference";
import { type Locale, localeLabels, locales } from "@/i18n/locales";
import { usePathname, useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

export function LocaleSwitcher() {
  const current = useLocale() as Locale;
  const t = useTranslations("localeSwitcher");
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  function onSelect(locale: Locale) {
    if (locale === current) return;
    startTransition(() => {
      // Server-rendered text in the cached reads is in the old locale:
      // refetch once the URL (and so `X-Locale`) has switched.
      persistLocale(locale);
      void router.replace(pathname, { locale }).then(() => router.refresh());
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <TooltipHint label={t("ariaLabel")}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("ariaLabel")}
              disabled={pending}
            />
          </TooltipHint>
        }
      >
        <Languages className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {locales.map((locale) => (
          <DropdownMenuItem
            key={locale}
            onClick={() => onSelect(locale)}
            className={cn(
              current === locale && "bg-accent text-accent-foreground"
            )}
          >
            {localeLabels[locale]}
            <DropdownMenuShortcut className="uppercase tracking-normal">
              {locale}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
