"use client";

import {
  ChevronsUpDown,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Server,
  Sun,
  UserRound,
  Users,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import * as React from "react";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { type Locale, localeLabels, locales } from "@/i18n/locales";
import { usePathname, useRouter } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";

type UserSummary = {
  id: string;
  name: string;
  email: string;
  image?: string | null;
};

const themeOptions = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
] as const;

export function UserMenu({
  user,
  isAdmin,
  variant = "avatar",
}: {
  user: UserSummary;
  isAdmin: boolean;
  variant?: "avatar" | "sidebar";
}) {
  const t = useTranslations("userMenu");
  const tTheme = useTranslations("themeSwitcher");
  const tLocale = useTranslations("localeSwitcher");
  const router = useRouter();
  const pathname = usePathname();
  const currentLocale = useLocale() as Locale;
  const { theme = "system", setTheme } = useTheme();
  const [pending, startTransition] = useTransition();

  async function onSignOut() {
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
  }

  function onLocaleChange(value: string) {
    const locale = value as Locale;
    if (locale === currentLocale) return;
    startTransition(() => {
      router.replace(pathname, { locale });
      router.refresh();
    });
  }

  const initials = (user.name || user.email)
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "sidebar" ? (
          <SidebarUserTrigger
            user={user}
            initials={initials}
            label={t("ariaLabel")}
          />
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label={t("ariaLabel")}
          >
            <span className="size-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold">
              {initials}
            </span>
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side={variant === "sidebar" ? "right" : "bottom"}
        sideOffset={variant === "sidebar" ? 8 : undefined}
        className="w-64"
      >
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm font-medium truncate">{user.name}</span>
            <span className="text-xs text-muted-foreground truncate">
              {user.email}
            </span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/account")}>
          <UserRound />
          {t("account")}
        </DropdownMenuItem>
        {isAdmin && (
          <>
            <DropdownMenuItem onClick={() => router.push("/users")}>
              <Users />
              {t("users")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push("/servers")}>
              <Server />
              {t("servers")}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {theme === "dark" ? (
              <Moon />
            ) : theme === "light" ? (
              <Sun />
            ) : (
              <Monitor />
            )}
            {tTheme("ariaLabel")}
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={theme}
                onValueChange={(v) => setTheme(v)}
              >
                {themeOptions.map(({ value, icon: Icon }) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    <Icon className="size-4" />
                    {tTheme(value)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={pending}>
            <Languages />
            {tLocale("ariaLabel")}
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={currentLocale}
                onValueChange={onLocaleChange}
              >
                {locales.map((locale) => (
                  <DropdownMenuRadioItem key={locale} value={locale}>
                    {localeLabels[locale]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onSignOut}>
          <LogOut />
          {t("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const SidebarUserTrigger = React.forwardRef<
  HTMLButtonElement,
  {
    user: UserSummary;
    initials: string;
    label: string;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function SidebarUserTrigger({ user, initials, label, ...props }, ref) {
  return (
    <SidebarMenuButton
      ref={ref}
      size="lg"
      aria-label={label}
      className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
      {...props}
    >
      <span className="size-8 rounded-md bg-muted flex items-center justify-center text-xs font-semibold shrink-0">
        {initials}
      </span>
      <div className="grid flex-1 text-left text-sm leading-tight min-w-0">
        <span className="truncate font-medium">{user.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {user.email}
        </span>
      </div>
      <ChevronsUpDown className="ml-auto size-4 opacity-60 shrink-0" />
    </SidebarMenuButton>
  );
});
