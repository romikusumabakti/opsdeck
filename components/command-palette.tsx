"use client";

import {
  Folder,
  KeyRound,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Search,
  Server,
  Sun,
  UserRound,
  Users,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { authClient } from "@/lib/auth-client";
import type { Project } from "@/lib/db/schema";

export function CommandPalette({
  projects,
  isAdmin,
}: {
  projects: Project[];
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("commandPalette");
  const tNav = useTranslations("nav");
  const tUserMenu = useTranslations("userMenu");
  const tTheme = useTranslations("themeSwitcher");
  const tHeader = useTranslations("header");
  const { setTheme } = useTheme();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  function run(fn: () => void) {
    setOpen(false);
    fn();
  }

  async function onSignOut() {
    setOpen(false);
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
  }

  function switchLocale(target: string) {
    if (target === locale) {
      setOpen(false);
      return;
    }
    setOpen(false);
    const path = window.location.pathname;
    const segs = path.split("/").filter(Boolean);
    if (routing.locales.includes(segs[0] as (typeof routing.locales)[number])) {
      segs[0] = target;
    } else {
      segs.unshift(target);
    }
    window.location.assign(`/${segs.join("/")}${window.location.search}`);
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-muted-foreground bg-muted/40 hover:bg-muted/60 gap-2 px-2.5 md:w-56 lg:w-64 md:justify-between font-normal"
        aria-label={t("triggerLabel")}
      >
        <span className="flex items-center gap-2 min-w-0">
          <Search className="size-4 shrink-0" />
          <span className="hidden md:inline text-sm truncate">
            {t("triggerLabel")}
          </span>
        </span>
        <kbd className="hidden md:inline-flex pointer-events-none h-5 select-none items-center gap-0.5 rounded border bg-background px-1.5 font-mono text-[10px] font-medium shrink-0">
          <span className="text-xs">⌘</span>K
        </kbd>
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        description={t("description")}
      >
        <CommandInput placeholder={t("placeholder")} />
        <CommandList>
          <CommandEmpty>{t("noResults")}</CommandEmpty>

          <CommandGroup heading={t("navigation")}>
            <CommandItem
              value="dashboard home"
              onSelect={() => run(() => router.push("/"))}
            >
              <Folder />
              {tNav("dashboard")}
            </CommandItem>
            {isAdmin && (
              <>
                <CommandItem
                  value="servers"
                  onSelect={() => run(() => router.push("/servers"))}
                >
                  <Server />
                  {tUserMenu("servers")}
                </CommandItem>
                <CommandItem
                  value="users"
                  onSelect={() => run(() => router.push("/users"))}
                >
                  <Users />
                  {tUserMenu("users")}
                </CommandItem>
              </>
            )}
          </CommandGroup>

          {projects.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading={t("projects")}>
                {projects.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`project ${p.name}`}
                    onSelect={() => run(() => router.push(`/projects/${p.id}`))}
                  >
                    <Folder />
                    <span className="truncate">{p.name}</span>
                  </CommandItem>
                ))}
                {isAdmin && (
                  <CommandItem
                    value="new project create"
                    onSelect={() => run(() => router.push("/projects/new"))}
                  >
                    <Plus />
                    {tHeader("createProject")}
                  </CommandItem>
                )}
              </CommandGroup>
            </>
          )}

          <CommandSeparator />
          <CommandGroup heading={t("account")}>
            <CommandItem
              value="account profile"
              onSelect={() => run(() => router.push("/account"))}
            >
              <UserRound />
              {tUserMenu("account")}
            </CommandItem>
            <CommandItem
              value="change password security"
              onSelect={() => run(() => router.push("/account?tab=security"))}
            >
              <KeyRound />
              {tUserMenu("changePassword")}
            </CommandItem>
            <CommandItem
              value="sessions devices"
              onSelect={() => run(() => router.push("/account?tab=sessions"))}
            >
              <Monitor />
              {tUserMenu("sessions")}
            </CommandItem>
            <CommandItem value="sign out logout" onSelect={onSignOut}>
              <LogOut />
              {tUserMenu("signOut")}
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />
          <CommandGroup heading={t("theme")}>
            <CommandItem
              value="theme light"
              onSelect={() => run(() => setTheme("light"))}
            >
              <Sun />
              {tTheme("light")}
            </CommandItem>
            <CommandItem
              value="theme dark"
              onSelect={() => run(() => setTheme("dark"))}
            >
              <Moon />
              {tTheme("dark")}
            </CommandItem>
            <CommandItem
              value="theme system"
              onSelect={() => run(() => setTheme("system"))}
            >
              <Monitor />
              {tTheme("system")}
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />
          <CommandGroup heading={t("language")}>
            {routing.locales.map((loc) => (
              <CommandItem
                key={loc}
                value={`language ${loc}`}
                onSelect={() => switchLocale(loc)}
              >
                <Languages />
                {t(`locale.${loc}`)}
                {loc === locale && (
                  <CommandShortcut>{t("current")}</CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
