import { useState } from "react";
import { useTranslations } from "use-intl";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { domainUrl } from "@/lib/domains/validation";
import type { DeployTargetState } from "@/web/api/deploys";
import type { EnvironmentDomain } from "@/web/api/environment-domains";
import type { MailpitSettings } from "@/web/api/mailpit-settings";
import { DeleteEnvironmentCard } from "../delete-environment-card";
import { DatabaseTab } from "./database-tab";
import { DomainTab } from "./domain-tab";
import { GeneralTab } from "./general-tab";
import { MailMockTimeTab } from "./mail-mock-time-tab";
import {
  type ServerOption,
  type SettingsEnvironment,
  type SettingsProject,
  serverOptions,
  useSettingsForm,
} from "./settings-form";
import { SourceDeployTab } from "./source-deploy-tab";

export const SETTINGS_TABS = [
  "general",
  "source",
  "database",
  "domain",
  "mail",
  "danger",
] as const;
export type SettingsTabId = (typeof SETTINGS_TABS)[number];

/**
 * The Settings page's search params: the open tab, and `add=target` to open
 * the add-target dialog (the Deploys page's empty state links there).
 */
export type SettingsSearch = { tab?: SettingsTabId; add?: "target" };

export function settingsSearch(
  search: Record<string, unknown>
): SettingsSearch {
  return {
    ...(SETTINGS_TABS.includes(search.tab as SettingsTabId) && {
      tab: search.tab as SettingsTabId,
    }),
    ...(search.add === "target" && { add: "target" as const }),
  };
}

const TAB_LABELS = {
  general: "tabGeneral",
  source: "tabSourceDeploy",
  database: "tabDatabase",
  domain: "tabDomain",
  mail: "tabMailMockTime",
  danger: "tabDanger",
} as const satisfies Record<SettingsTabId, string>;

/**
 * The environment's Settings: six tabs over one form state. Each tab saves on
 * its own (Domain and Mailpit through their own APIs).
 */
export function EnvironmentSettingsTabs({
  environment,
  targets,
  domain,
  mailpit,
  servers,
  projects,
  projectKey,
  canManageServers,
  canDuplicate,
  tab: controlledTab,
  onTabChange,
  addingTarget,
  onAddingTargetChange,
}: {
  environment: SettingsEnvironment;
  targets: DeployTargetState[];
  domain: EnvironmentDomain;
  mailpit: MailpitSettings | null;
  // The servers the caller may bind: all of them with org server:manage,
  // else the ones placement admits (setup options).
  servers: ServerOption[];
  projects: SettingsProject[];
  projectKey: string;
  canManageServers: boolean;
  canDuplicate: boolean;
  tab?: SettingsTabId;
  onTabChange?: (tab: SettingsTabId) => void;
  // The add-target dialog of Source & Deploy, when the caller controls it.
  addingTarget?: boolean;
  onAddingTargetChange?: (open: boolean) => void;
}) {
  const t = useTranslations("environmentSettings");
  const [ownTab, setOwnTab] = useState<SettingsTabId>("general");
  const tab = controlledTab ?? ownTab;
  const { form, saveTab } = useSettingsForm(environment, targets, {
    canManageServers,
    hasDomain: domain.domain !== null,
  });
  const options = serverOptions(environment, servers);
  // Mirrors the server's rebinding rule: any deployment row of the
  // environment (every one belongs to a target) freezes it for engineers.
  const deployed = targets.some(
    (target) => target.recentDeployments.length > 0
  );

  return (
    <Form {...form}>
      <Tabs
        value={tab}
        onValueChange={(value: SettingsTabId) => {
          setOwnTab(value);
          onTabChange?.(value);
        }}
        className="w-full max-w-2xl"
      >
        <TabsList className="h-auto flex-wrap">
          {SETTINGS_TABS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {t(TAB_LABELS[id])}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="general">
          <GeneralTab
            environment={environment}
            domainUrl={domain.domain ? domainUrl(domain.domain.hostname) : null}
            projects={projects}
            projectKey={projectKey}
            canDuplicate={canDuplicate}
            onSave={() => saveTab("general")}
          />
        </TabsContent>

        <TabsContent value="source">
          <SourceDeployTab
            environment={environment}
            servers={options}
            canManageServers={canManageServers}
            deployed={deployed}
            adding={addingTarget}
            onAddingChange={onAddingTargetChange}
            onSave={() => saveTab("source")}
          />
        </TabsContent>

        <TabsContent value="database">
          <DatabaseTab
            environment={environment}
            servers={options}
            projectKey={projectKey}
            canManageServers={canManageServers}
            onSave={() => saveTab("database")}
          />
        </TabsContent>

        <TabsContent value="domain">
          <DomainTab environmentId={environment.id} domain={domain} />
        </TabsContent>

        <TabsContent value="mail">
          <MailMockTimeTab
            environment={environment}
            mailpit={mailpit}
            canManageServers={canManageServers}
            onSave={() => saveTab("mail")}
          />
        </TabsContent>

        <TabsContent value="danger">
          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="text-destructive">
                {t("dangerZoneTitle")}
              </CardTitle>
              <CardDescription>{t("dangerZoneDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <DeleteEnvironmentCard
                environment={environment}
                projectKey={projectKey}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </Form>
  );
}
