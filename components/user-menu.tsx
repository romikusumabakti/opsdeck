"use client";

import {
  ChevronsUpDown,
  IdCard,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Smile,
  Sun,
  UserRound,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import * as React from "react";
import { useTransition } from "react";
import { AccentDot } from "@/components/accent-dot";
import { useAccent } from "@/components/accent-provider";
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
import { StatusDialog } from "@/components/user/status-dialog";
import { UserAvatar } from "@/components/user/user-avatar";
import { type Locale, localeLabels, locales } from "@/i18n/locales";
import { usePathname, useRouter } from "@/i18n/navigation";
import { ACCENTS, type AccentColor } from "@/lib/accents";
import { authClient } from "@/lib/auth-client";

export type UserSummary = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  status: {
    emoji: string | null;
    text: string | null;
    expiresAt: string | null;
  } | null;
  timeZone: string;
};

const themeOptions = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
] as const;

export function UserMenu({
  user,
  variant = "avatar",
}: {
  user: UserSummary;
  variant?: "avatar" | "sidebar";
}) {
  const t = useTranslations("userMenu");
  const tTheme = useTranslations("themeSwitcher");
  const tAccent = useTranslations("accentSwitcher");
  const { accent, setAccent } = useAccent();
  const router = useRouter();
  const pathname = usePathname();
  const currentLocale = useLocale() as Locale;
  const { theme = "system", setTheme } = useTheme();
  const [pending, startTransition] = useTransition();
  const [statusOpen, setStatusOpen] = React.useState(false);

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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            variant === "sidebar" ? (
              <SidebarUserTrigger user={user} label={t("ariaLabel")} />
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                aria-label={t("ariaLabel")}
              >
                <UserAvatar user={user} size="md" />
              </Button>
            )
          }
        />
        <DropdownMenuContent
          align="end"
          side={variant === "sidebar" ? "right" : "bottom"}
          sideOffset={variant === "sidebar" ? 8 : undefined}
          className="w-64"
        >
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm font-medium text-foreground truncate">
                {user.name}
              </span>
              <span className="text-xs truncate">{user.email}</span>
            </div>
          </DropdownMenuLabel>
          {/* The status doubles as its own edit control, GitHub-style. */}
          <DropdownMenuItem onClick={() => setStatusOpen(true)}>
            {user.status ? (
              <>
                <span className="sr-only">{t("editStatus")}: </span>
                {user.status.emoji ? (
                  <span className="w-4 text-center leading-none">
                    {user.status.emoji}
                  </span>
                ) : (
                  <Smile />
                )}
                <span className="truncate">{user.status.text}</span>
              </>
            ) : (
              <>
                <Smile />
                <span className="text-muted-foreground">{t("setStatus")}</span>
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push(`/people/${user.id}`)}>
            <IdCard />
            {t("myProfile")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/account")}>
            <UserRound />
            {t("account")}
          </DropdownMenuItem>
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
              {t("theme")}
              <CurrentValue>{tTheme(theme)}</CurrentValue>
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
            <DropdownMenuSubTrigger>
              <AccentDot accent={accent} className="mx-0.5" />
              {t("accent")}
              <CurrentValue>{tAccent(accent)}</CurrentValue>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={accent}
                  onValueChange={(v) => setAccent(v as AccentColor)}
                >
                  {ACCENTS.map((a) => (
                    <DropdownMenuRadioItem key={a} value={a}>
                      <AccentDot accent={a} />
                      {tAccent(a)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={pending}>
              <Languages />
              {t("language")}
              <CurrentValue>{localeLabels[currentLocale]}</CurrentValue>
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
          <DropdownMenuItem onClick={onSignOut}>
            <LogOut />
            {t("signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <StatusDialog
        key={`${user.status?.emoji}|${user.status?.text}|${user.status?.expiresAt}`}
        open={statusOpen}
        onOpenChange={setStatusOpen}
        current={user.status}
        timeZone={user.timeZone}
      />
    </>
  );
}

// The active choice, shown before a preference submenu's chevron. It takes
// all the free space (rather than `ms-auto`) so the chevron's own auto margin
// gets none, keeping every value flush against its chevron.
function CurrentValue({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex-1 truncate text-end text-xs text-muted-foreground">
      {children}
    </span>
  );
}

const SidebarUserTrigger = React.forwardRef<
  HTMLButtonElement,
  {
    user: UserSummary;
    label: string;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function SidebarUserTrigger({ user, label, ...props }, ref) {
  return (
    <SidebarMenuButton
      ref={ref}
      size="lg"
      aria-label={label}
      className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
      {...props}
    >
      <UserAvatar user={user} size="md" />
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
