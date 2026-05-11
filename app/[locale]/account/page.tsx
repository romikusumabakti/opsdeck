import { KeyRound, Monitor, UserRound } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChangePasswordForm } from "@/app/[locale]/account/change-password/change-password-form";
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
import { ProfileCard } from "./profile-card";
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

  const defaultTab = tab === "security" || tab === "sessions" ? tab : "profile";

  return (
    <div className="max-w-3xl py-8 mx-auto w-full px-4 flex flex-col gap-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Tabs defaultValue={defaultTab} className="gap-6">
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

        <TabsContent value="profile">
          <ProfileCard
            user={{
              id: session.user.id,
              name: session.user.name,
              email: session.user.email,
              emailVerified: session.user.emailVerified,
              image: session.user.image ?? null,
            }}
          />
        </TabsContent>

        <TabsContent value="security">
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
    </div>
  );
}
