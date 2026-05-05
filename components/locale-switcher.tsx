"use client";

import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { setLocale } from "@/actions/locale";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { type Locale, localeLabels, locales } from "@/i18n/locales";
import { cn } from "@/lib/utils";

export function LocaleSwitcher() {
  const current = useLocale() as Locale;
  const t = useTranslations("localeSwitcher");
  const [pending, startTransition] = useTransition();

  function onSelect(locale: Locale) {
    if (locale === current) return;
    startTransition(() => {
      setLocale(locale);
    });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("ariaLabel")}
          disabled={pending}
        >
          <Languages className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-1">
        {locales.map((locale) => (
          <button
            key={locale}
            type="button"
            onClick={() => onSelect(locale)}
            className={cn(
              "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground",
              current === locale && "bg-accent text-accent-foreground"
            )}
          >
            <span>{localeLabels[locale]}</span>
            <span className="text-xs uppercase text-muted-foreground">
              {locale}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
