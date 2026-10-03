import { ChevronRight, ServerCog } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { RecentEnvironment } from "@/lib/home/queries";
import { BackupButton } from "./backup-button";
import { CompactSection, HomeSection } from "./home-section";
import { SectionError } from "./section-error";

export function RecentEnvsSection({
  environments,
}: {
  environments: RecentEnvironment[] | null;
}) {
  const t = useTranslations("homePage");
  if (environments && environments.length === 0) {
    return (
      <CompactSection
        icon={ServerCog}
        title={t("recent.title")}
        text={t("recent.empty")}
      />
    );
  }
  return (
    <HomeSection icon={ServerCog} title={t("recent.title")}>
      {environments === null ? (
        <SectionError />
      ) : (
        <ul className="flex flex-col divide-y">
          {environments.map((env) => (
            <li
              key={env.id}
              className="group flex items-center gap-1 pe-2 transition-colors hover:bg-accent/50"
            >
              <Link
                href={env.path}
                title={`${env.name} — ${env.projectName}`}
                className="flex min-w-0 flex-1 flex-col px-3 py-2"
              >
                <span className="truncate text-sm">{env.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {env.projectName}
                </span>
              </Link>
              {env.hasDatabase && env.canBackup ? (
                <BackupButton environmentId={env.id} />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              )}
            </li>
          ))}
        </ul>
      )}
    </HomeSection>
  );
}
