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

export function CommandPalette({ projects }: { projects: Project[] }) {
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
        className="text-muted-foreground gap-2 px-2"
        aria-label={t("triggerLabel")}
      >
        <Search className="size-4" />
        <span className="hidden md:inline text-xs">{t("triggerLabel")}</span>
        <kbd className="hidden md:inline-flex pointer-events-none h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium">
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
                <CommandItem
                  value="new project create"
                  onSelect={() => run(() => router.push("/projects/new"))}
                >
                  <Plus />
                  {tHeader("createProject")}
                </CommandItem>
              </CommandGroup>
            </>
          )}

          <CommandSeparator />
          <CommandGroup heading={t("account")}>
            <CommandItem
              value="change password"
              onSelect={() =>
                run(() => router.push("/account/change-password"))
              }
            >
              <KeyRound />
              {tUserMenu("changePassword")}
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
