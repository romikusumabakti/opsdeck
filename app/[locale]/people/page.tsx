import { getTranslations, setRequestLocale } from "next-intl/server";
import { listProjects } from "@/actions/project-catalog";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth-session";
import { listPeople } from "@/lib/people/queries";
import { PeopleClient } from "./people-client";

export default async function PeoplePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireSession();
  const [people, projects, t] = await Promise.all([
    listPeople(session.user.role),
    listProjects(),
    getTranslations("people"),
  ]);
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <PeopleClient
        people={people}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      />
    </>
  );
}
