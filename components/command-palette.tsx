import {
  Activity,
  Ban,
  BookOpen,
  Cable,
  CalendarDays,
  CircleDot,
  Folder,
  FolderKanban,
  KeyRound,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Search,
  Server,
  Shapes,
  Sun,
  UserRound,
  Users,
  UsersRound,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { AccentDot } from "@/components/accent-dot";
import { useAccent } from "@/components/accent-provider";
import { useMotif } from "@/components/motif-provider";
import { EnvironmentKindBadge } from "@/components/nav/environment-kind-badge";
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
import { useModKey } from "@/hooks/use-is-mac";
import { type Locale, locales } from "@/i18n/locales";
import { usePathname, useRouter } from "@/i18n/navigation";
import { ACCENTS } from "@/lib/accents";
import { authClient } from "@/lib/auth-client";
import { MOTIFS } from "@/lib/motifs";
import {
  groupEnvironmentsByProject,
  type NavProject,
  stripProjectPrefix,
} from "@/lib/nav-path";
import {
  canCreateEnvironment as canCreateEnvironmentIn,
  canOrg,
  type OrgRole,
  type ProjectRole,
} from "@/lib/permissions";
import type { EnvironmentListItem } from "@/web/api/environments";
import { resetSession } from "@/web/api/session";

export function CommandPalette({
  environments,
  projects,
  orgRole,
  projectRoles,
}: {
  environments: EnvironmentListItem[];
  projects: readonly NavProject[];
  orgRole: OrgRole;
  projectRoles: Record<string, ProjectRole>;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const locale = useLocale();
  const t = useTranslations("commandPalette");
  const tNav = useTranslations("nav");
  const tUserMenu = useTranslations("userMenu");
  const tTheme = useTranslations("themeSwitcher");
  const tAccent = useTranslations("accentSwitcher");
  const { setAccent } = useAccent();
  const tMotif = useTranslations("motifs");
  const { setPreference } = useMotif();
  const tHeader = useTranslations("header");
  const modKey = useModKey();
  const { setTheme } = useTheme();
  // The palette has no project context: offer "create environment" when any
  // project the caller can see lets them. The create dialog re-checks per project.
  const canCreateEnvironment = Object.values(projectRoles).some((role) =>
    canCreateEnvironmentIn(orgRole, role)
  );
  const environmentGroups = useMemo(
    () => groupEnvironmentsByProject(projects, environments),
    [projects, environments]
  );

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
    // Forget the old session's data before the gate sees the next page.
    await resetSession();
    router.push("/sign-in");
  }

  function switchLocale(target: Locale) {
    setOpen(false);
    if (target === locale) return;
    // Server-rendered text in the cached reads is in the old locale: refetch
    // once the URL (and so `X-Locale`) has switched.
    void router
      .replace(pathname, { locale: target })
      .then(() => router.refresh());
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
          <span className={modKey === "⌘" ? "text-xs" : ""}>{modKey}</span>K
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
              {tNav("home")}
            </CommandItem>
            <CommandItem
              value="projects environments"
              onSelect={() => run(() => router.push("/projects"))}
            >
              <FolderKanban />
              {tNav("projects")}
            </CommandItem>
            <CommandItem
              value="issues bugs tasks"
              onSelect={() => run(() => router.push("/issues"))}
            >
              <CircleDot />
              {tNav("allIssues")}
            </CommandItem>
            <CommandItem
              value="knowledge base docs wiki"
              onSelect={() => run(() => router.push("/knowledge"))}
            >
              <BookOpen />
              {tNav("knowledge")}
            </CommandItem>
            <CommandItem
              value="people team directory profiles"
              onSelect={() => run(() => router.push("/people"))}
            >
              <UsersRound />
              {tNav("people")}
            </CommandItem>
            {canOrg(orgRole, { server: ["read"] }) && (
              <CommandItem
                value="servers"
                onSelect={() => run(() => router.push("/servers"))}
              >
                <Server />
                {tUserMenu("servers")}
              </CommandItem>
            )}
            {canOrg(orgRole, { audit: ["read"] }) && (
              <CommandItem
                value="activity audit feed events"
                onSelect={() => run(() => router.push("/admin/activity"))}
              >
                <Activity />
                {tNav("activity")}
              </CommandItem>
            )}
            {canOrg(orgRole, { integration: ["manage"] }) && (
              <CommandItem
                value="jira integration connections"
                onSelect={() => run(() => router.push("/admin/jira"))}
              >
                <Cable />
                {tNav("jira")}
              </CommandItem>
            )}
            {canOrg(orgRole, { user: ["list"] }) && (
              <CommandItem
                value="users"
                onSelect={() => run(() => router.push("/admin/users"))}
              >
                <Users />
                {tUserMenu("users")}
              </CommandItem>
            )}
          </CommandGroup>

          {projects.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading={t("projects")}>
                {projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={`project ${project.name} ${project.key}`}
                    onSelect={() => run(() => router.push(`/${project.key}`))}
                  >
                    <FolderKanban />
                    <span className="truncate">{project.name}</span>
                    <CommandShortcut className="font-mono">
                      {project.key}
                    </CommandShortcut>
                  </CommandItem>
                ))}
                {canCreateEnvironment && (
                  // An environment needs a parent project, so the palette (which
                  // has no project context) sends the user to the list, where
                  // every project card carries the action.
                  <CommandItem
                    value="new environment create"
                    onSelect={() => run(() => router.push("/projects"))}
                  >
                    <Plus />
                    {tHeader("createEnvironment")}
                  </CommandItem>
                )}
              </CommandGroup>
            </>
          )}

          {environmentGroups.map(({ project, environments: envs }) => (
            <Fragment key={project.id}>
              <CommandSeparator />
              <CommandGroup heading={project.name}>
                {envs.map((env) => (
                  <CommandItem
                    key={env.id}
                    // Project-qualified so same-named environments in two
                    // projects stay distinct and searchable by project.
                    value={`environment ${project.name} ${project.key} ${env.name}`}
                    onSelect={() =>
                      run(() => router.push(`/${env.key}/${env.slug}`))
                    }
                  >
                    <Folder />
                    <span className="flex-1 min-w-0 truncate">
                      {stripProjectPrefix(env.name, project.name)}
                    </span>
                    <EnvironmentKindBadge kind={env.kind} />
                  </CommandItem>
                ))}
              </CommandGroup>
            </Fragment>
          ))}

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
          <CommandGroup heading={tAccent("ariaLabel")}>
            {ACCENTS.map((a) => (
              <CommandItem
                key={a}
                value={`accent ${a}`}
                onSelect={() => run(() => setAccent(a))}
              >
                <AccentDot accent={a} />
                {tAccent(a)}
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandSeparator />
          <CommandGroup heading={tMotif("label")}>
            <CommandItem
              value="motif daily"
              onSelect={() => run(() => setPreference("daily"))}
            >
              <CalendarDays />
              {tMotif("daily")}
            </CommandItem>
            <CommandItem
              value="motif none"
              onSelect={() => run(() => setPreference("none"))}
            >
              <Ban />
              {tMotif("none")}
            </CommandItem>
            {MOTIFS.map((m) => (
              <CommandItem
                key={m.slug}
                value={`motif ${m.name} ${tMotif(`items.${m.slug}.region`)}`}
                onSelect={() => run(() => setPreference(m.slug))}
              >
                <Shapes />
                {m.name}
                <span className="ms-auto text-xs text-muted-foreground">
                  {tMotif(`items.${m.slug}.region`)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandSeparator />
          <CommandGroup heading={t("language")}>
            {locales.map((loc) => (
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
