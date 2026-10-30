import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, Loader2, Monitor, UserRound } from "lucide-react";
import { useTranslations } from "use-intl";
import { NotificationsToggle } from "@/components/notifications-toggle";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/lib/auth-client";
import type { WorkingHours } from "@/lib/user-display";
import { getAccountQuery } from "@/web/api/profile";
import { useBootstrap, useMe } from "@/web/api/session";
import { ChangePasswordForm } from "./-components/account/change-password-form";
import { PasskeysList } from "./-components/account/passkeys-list";
import { ProfileForm } from "./-components/account/profile-form";
import { SessionsList } from "./-components/account/sessions-list";

type AccountTab = "profile" | "security" | "sessions";

export const Route = createFileRoute("/$locale/_app/account/")({
  validateSearch: (search: Record<string, unknown>): { tab?: AccountTab } => ({
    tab:
      search.tab === "security" || search.tab === "sessions"
        ? search.tab
        : undefined,
  }),
  loader: async ({ context: { queryClient } }) => {
    await queryClient.query(getAccountQuery());
  },
  component: AccountPage,
});

function AccountPage() {
  const { tab } = Route.useSearch();
  const t = useTranslations("account");
  const tNotif = useTranslations("notifications");
  const tPasskeys = useTranslations("account.passkeys");
  const me = useMe();
  const { appTimeZone } = useBootstrap();
  const account = useSuspenseQuery(getAccountQuery()).data;
  // The sessions list marks the row for this browser; its token is
  // better-auth's, and it changes when the password change revokes the others.
  const { data: authSession } = useSession();

  const defaultTab = tab ?? "profile";
  if (!me) return null;
  const { user } = me;

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Tabs defaultValue={defaultTab} className="gap-6 max-w-3xl w-full">
        <TabsList>
          <TabsTrigger value="profile">
            <UserRound className="size-4" />
            {t("tabs.profile")}
          </TabsTrigger>
          <TabsTrigger value="security">
            <KeyRound className="size-4" />
            {t("tabs.security")}
          </TabsTrigger>
          <TabsTrigger value="sessions">
            <Monitor className="size-4" />
            {t("tabs.sessions")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("profile.title")}</CardTitle>
              <CardDescription>{t("profile.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <ProfileForm
                user={{
                  id: user.id,
                  name: user.name,
                  email: user.email,
                  image: user.image ?? null,
                  title: user.title ?? null,
                  bio: user.bio ?? null,
                  timezone: user.timezone ?? null,
                  workingHours: (user.workingHours ??
                    null) as WorkingHours | null,
                }}
                appTimeZone={appTimeZone}
                hasMicrosoft={account.hasMicrosoftAccount}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{tNotif("title")}</CardTitle>
              <CardDescription>{tNotif("description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <NotificationsToggle />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{tPasskeys("title")}</CardTitle>
              <CardDescription>{tPasskeys("description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <PasskeysList />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("security.title")}</CardTitle>
              <CardDescription>{t("security.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <ChangePasswordForm />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sessions">
          <Card>
            <CardHeader>
              <CardTitle>{t("sessions.title")}</CardTitle>
              <CardDescription>{t("sessions.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              {authSession ? (
                <SessionsList currentToken={authSession.session.token} />
              ) : (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
