import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { AccentProvider } from "@/components/accent-provider";
import { ActiveRunsIndicator } from "@/components/active-runs-indicator";
import { ActiveRunsProvider } from "@/components/active-runs-provider";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { HeaderBreadcrumb } from "@/components/header-breadcrumb";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { MotifProvider } from "@/components/motif-provider";
import { NotificationBell } from "@/components/notification-bell";
import { ServerTime } from "@/components/server-time";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TimezoneHint } from "@/components/user/timezone-hint";
import { isRtlLocale } from "@/i18n/locales";
import { effectiveAccent } from "@/lib/accents";
import { dailyMotif, effectiveMotifPreference } from "@/lib/motifs";
import { activeStatus } from "@/lib/user-display";
import { listEnvironmentsQuery } from "@/web/api/environments";
import { getAssignedIssueCountsQuery } from "@/web/api/issues";
import {
  getUnreadNotificationCountQuery,
  listNotificationsQuery,
} from "@/web/api/notifications";
import {
  getMyProjectAccessQuery,
  listProjectsQuery,
} from "@/web/api/project-catalog";
import { useBootstrap, useMe } from "@/web/api/session";
import { LocaleNotFoundContent } from "@/web/components/locale-fallbacks";
import { loaderQuery } from "@/web/query-client";

// The signed-in app shell (the port of the signed-in branch of
// app/[locale]/layout.tsx). Pathless: every authenticated page is a child,
// and the $locale gate has already sent signed-out visitors to sign-in.
export const Route = createFileRoute("/$locale/_app")({
  // What the shell reads on every page: the sidebar, the breadcrumb and
  // palette pickers, and the notification bell. Loaded together: serially
  // they would stack six round-trips in front of every first paint. Only the
  // first load waits: after that this runs on every navigation, and cached
  // data is served at once while a stale entry refetches behind it.
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      loaderQuery(queryClient, listEnvironmentsQuery()),
      loaderQuery(queryClient, listProjectsQuery()),
      loaderQuery(queryClient, listNotificationsQuery()),
      loaderQuery(queryClient, getUnreadNotificationCountQuery()),
      loaderQuery(queryClient, getAssignedIssueCountsQuery()),
      loaderQuery(queryClient, getMyProjectAccessQuery()),
    ]);
  },
  component: AppShell,
  // A page's `throw notFound()` lands here — the nearest route with a
  // notFoundComponent — and TanStack renders this in place of the shell, so
  // it brings the shell back around the 404. Pages need no opt-in.
  notFoundComponent: () => (
    <AppShell>
      <LocaleNotFoundContent />
    </AppShell>
  ),
});

function AppShell({ children }: { children?: ReactNode }) {
  const me = useMe();
  // Signing out refetches `/api/me` in place (resetSession) before navigating
  // away, so the shell re-renders with null for a moment: render nothing
  // then rather than a shell with no user.
  if (!me) return null;
  return <SignedInShell me={me}>{children ?? <Outlet />}</SignedInShell>;
}

function SignedInShell({
  me,
  children,
}: {
  me: NonNullable<ReturnType<typeof useMe>>;
  children: ReactNode;
}) {
  const { locale } = Route.useParams();
  const t = useTranslations("header");
  const bootstrap = useBootstrap();
  const environments = useSuspenseQuery(listEnvironmentsQuery()).data;
  const projects = useSuspenseQuery(listProjectsQuery()).data;
  const notifications = useSuspenseQuery(listNotificationsQuery()).data;
  const unreadCount = useSuspenseQuery(getUnreadNotificationCountQuery()).data;
  const issueCounts = useSuspenseQuery(getAssignedIssueCountsQuery()).data;
  const projectRoles = useSuspenseQuery(getMyProjectAccessQuery()).data.roles;

  const { user, orgRole, timeZone } = me;
  const rtl = isRtlLocale(locale);
  // Slim projection for the client-side pickers (header switchers, palette).
  const navProjects = projects.map(({ id, key, name }) => ({ id, key, name }));
  const status = activeStatus(user);
  // Same for everyone on the same day in the app's zone.
  const todayMotif = dailyMotif(new Date(), bootstrap.appTimeZone);

  return (
    // One run stream for the whole shell — the header indicator and the
    // sidebar History badge both read it.
    <AccentProvider initial={effectiveAccent(user, bootstrap.brand)}>
      <MotifProvider
        initial={effectiveMotifPreference(user)}
        today={todayMotif}
      >
        <ActiveRunsProvider>
          <SidebarProvider>
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              {t("skipToContent")}
            </a>
            <AppSidebar
              environments={environments}
              orgRole={orgRole}
              projectRoles={projectRoles}
              issueCounts={issueCounts}
              logo={bootstrap.brand}
              side={rtl ? "right" : "left"}
              user={{
                id: user.id,
                name: user.name,
                email: user.email,
                image: user.image ?? null,
                status: status && {
                  ...status,
                  expiresAt: status.expiresAt?.toISOString() ?? null,
                },
                timeZone,
              }}
            />
            <SidebarInset className="min-w-0">
              <header className="flex h-14 shrink-0 items-center gap-2 bg-background px-4">
                <SidebarTrigger className="-ms-1" />
                <HeaderBreadcrumb
                  environments={environments}
                  projects={navProjects}
                  orgRole={orgRole}
                  projectRoles={projectRoles}
                />
                <div className="ms-auto flex shrink-0 items-center gap-2">
                  <ActiveRunsIndicator />
                  <div className="hidden md:flex items-center gap-2 pe-1">
                    <ServerTime timeZone={bootstrap.appTimeZone} />
                  </div>
                  <NotificationBell
                    initialNotifications={notifications}
                    initialUnread={unreadCount}
                  />
                  <CommandPalette
                    environments={environments}
                    projects={navProjects}
                    orgRole={orgRole}
                    projectRoles={projectRoles}
                  />
                </div>
              </header>
              {/* `main`, not the document, is the scroller: the router resets
                  it on navigation and restores it on back/forward
                  (web/router.tsx). scroll-pt-6 matches py-6 so a
                  scrolled-to anchor keeps the top padding. */}
              <main
                id="main-content"
                tabIndex={-1}
                data-scroll-shadow
                data-scroll-restoration-id="main-content"
                className="flex-1 min-h-0 overflow-y-auto scroll-pt-6 flex flex-col gap-6 px-4 sm:px-6 lg:px-8 py-6 focus:outline-none"
              >
                {!user.timezone && (
                  <TimezoneHint appTimeZone={bootstrap.appTimeZone} />
                )}
                {children}
              </main>
            </SidebarInset>
            <KeyboardShortcuts />
          </SidebarProvider>
        </ActiveRunsProvider>
      </MotifProvider>
    </AccentProvider>
  );
}
