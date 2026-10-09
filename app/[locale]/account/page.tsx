import { KeyRound, Monitor, UserRound } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChangePasswordForm } from "@/app/[locale]/account/change-password/change-password-form";
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
import { redirect } from "@/i18n/navigation";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { APP_TIMEZONE } from "@/lib/timezone";
import type { WorkingHours } from "@/lib/user-display";
import { PasskeysList } from "./passkeys-list";
import { ProfileForm } from "./profile-form";
import { SessionsList } from "./sessions-list";

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ locale }, { tab }] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);

  const session = await requireSession();
  if (!session) {
    await redirect("/sign-in?redirect=/account");
    return null;
  }

  const t = await getTranslations("account");
  const tNotif = await getTranslations("notifications");
  const tPasskeys = await getTranslations("account.passkeys");

  const microsoftAccount = await db.query.accounts.findFirst({
    where: { userId: session.user.id, providerId: "microsoft" },
    columns: { id: true },
  });

  const defaultTab = tab === "security" || tab === "sessions" ? tab : "profile";

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
              <CardDescription>
                {t("profile.description")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ProfileForm
                user={{
                  id: session.user.id,
                  name: session.user.name,
                  email: session.user.email,
                  image: session.user.image ?? null,
                  title: session.user.title ?? null,
                  bio: session.user.bio ?? null,
                  timezone: session.user.timezone ?? null,
                  workingHours: (session.user.workingHours ?? null) as WorkingHours | null,
                }}
                appTimeZone={APP_TIMEZONE}
                hasMicrosoft={Boolean(microsoftAccount)}
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
              <SessionsList currentToken={session.session.token} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
