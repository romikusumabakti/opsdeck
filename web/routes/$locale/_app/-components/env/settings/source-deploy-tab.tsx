import { Plus } from "lucide-react";
import { useState } from "react";
import { useWatch } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { AdvancedOptions } from "@/components/advanced-options";
import { useProjectCan } from "@/components/project-role";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  missingRequiredNames,
  SHARED_DEPLOY_DIR_MESSAGE,
} from "@/lib/variables/errors";
import { ApiError } from "@/web/api/client";
import { setEnvFileManaged } from "@/web/api/variables";
import { TargetFormDialog } from "../deploys/target-form-dialog";
import { useVariableErrorText } from "../variables/variable-form-dialog";
import { EnumSelect, Hint, SaveButton, ServerSelect } from "./fields";
import {
  ownsContainerDb,
  SERVICE_TYPES,
  type ServerOption,
  type SettingsEnvironment,
  type SettingsTarget,
  useSettingsFormContext,
} from "./settings-form";

type TextField =
  | "sourceBranch"
  | "deployDir"
  | "services"
  | "tagVariable"
  | "preStartCommand"
  | "healthUrl"
  | "healthTimeoutSeconds";

/**
 * Per repo its branch and auto-deploy, and the environment's one server.
 * Advanced options hold the rest of each deploy target, the services'
 * own servers, types and names, and the managed `.env` switch.
 *
 * The server can be changed by an engineer only before the first deploy
 * (server/services/environments#updateEnvironment); org server:manage may
 * always change it and is the only one to edit the services themselves.
 */
export function SourceDeployTab({
  environment,
  servers,
  canManageServers,
  deployed,
  onSave,
}: {
  environment: SettingsEnvironment;
  servers: ServerOption[];
  canManageServers: boolean;
  // The environment has a deployment (any target, any status).
  deployed: boolean;
  onSave: () => Promise<void>;
}) {
  const t = useTranslations("environmentSettings");
  const tForm = useTranslations("environmentForm");
  const tTarget = useTranslations("deploys.form");
  const tDeploys = useTranslations("deploys");
  const tEnums = useTranslations("dashboard");
  const form = useSettingsFormContext();
  const { errors } = form.formState;
  const canConfigure = useProjectCan({ deploy: ["configure"] });
  const [adding, setAdding] = useState(false);

  const targets = useWatch({ control: form.control, name: "targets" });
  const [backendServerId, frontendServerId, dbServerId] = useWatch({
    control: form.control,
    name: ["backendServerId", "frontendServerId", "dbServerId"],
  });
  const [hasFrontend, hasDatabase, dbKind] = useWatch({
    control: form.control,
    name: ["hasFrontend", "hasDatabase", "dbKind"],
  });
  // "This environment runs on this server": the picker binds the app's
  // services, the deploy targets and an own-container database. A shared
  // database stays with its host, so its server is never moved.
  const ownDb = ownsContainerDb({ hasDatabase, dbKind });
  const sharedDb = hasDatabase && dbKind === "shared";
  const appServers = [
    backendServerId,
    ...(hasFrontend ? [frontendServerId] : []),
    ...(ownDb ? [dbServerId] : []),
  ].filter((id) => id !== "");
  const mixed = new Set(appServers).size > 1;
  const locked = deployed && !canManageServers;
  const savedServerId = form.formState.defaultValues?.backendServerId ?? "";
  // Moving the app away from its shared database's host would break the
  // setup: the save is blocked until the server is put back.
  const sharedDbElsewhere =
    sharedDb &&
    backendServerId !== savedServerId &&
    backendServerId !== dbServerId;
  // Engineers are not offered that move at all.
  const pickerServers =
    sharedDb && !canManageServers
      ? servers.filter((s) => s.id === savedServerId || s.id === dbServerId)
      : servers;
  const names = new Map(servers.map((s) => [s.id, s.name]));
  // A target deploys to one of the servers the services run on (a shared
  // database's server comes from its host and is not one of them here).
  const ownsDbServer = hasDatabase && dbKind !== "shared";
  const targetServers = [
    ...new Set([
      ...appServers,
      ...(ownsDbServer && dbServerId ? [dbServerId] : []),
    ]),
  ].map((id) => ({ id, name: names.get(id) ?? id }));

  function onServer(serverId: string) {
    const opts = { shouldDirty: true } as const;
    form.setValue("backendServerId", serverId, opts);
    if (hasFrontend) form.setValue("frontendServerId", serverId, opts);
    if (ownDb) form.setValue("dbServerId", serverId, opts);
    for (const index of targets.keys()) {
      form.setValue(`targets.${index}.serverId`, serverId, opts);
    }
  }

  const targetText = (
    index: number,
    name: TextField,
    props: React.ComponentProps<typeof Input> = {}
  ) => (
    <FormField
      control={form.control}
      name={`targets.${index}.${name}`}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{tTarget(name)}</FormLabel>
          <FormControl>
            <Input
              autoComplete="off"
              spellCheck={false}
              disabled={!canConfigure}
              {...field}
              {...props}
            />
          </FormControl>
          <Hint>{tTarget(`${name}Hint`)}</Hint>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const targetSwitch = (
    index: number,
    name: "autoDeploy" | "backupBeforeDeploy"
  ) => (
    <FormField
      control={form.control}
      name={`targets.${index}.${name}`}
      render={({ field }) => (
        <FormItem className="flex items-center gap-2">
          <FormControl>
            <Switch
              checked={field.value}
              onCheckedChange={field.onChange}
              disabled={!canConfigure}
            />
          </FormControl>
          <FormLabel className="font-normal">{tTarget(name)}</FormLabel>
        </FormItem>
      )}
    />
  );

  const service = (role: "backend" | "frontend") => (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField
        control={form.control}
        name={`${role}ServerId`}
        render={({ field }) => (
          <FormItem className="sm:col-span-2">
            <FormLabel htmlFor={`server-${role}`}>{tForm("server")}</FormLabel>
            <ServerSelect
              id={`server-${role}`}
              value={field.value}
              onChange={field.onChange}
              servers={servers}
              disabled={!canManageServers}
            />
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name={`${role}ServiceType`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>{tForm("serviceType")}</FormLabel>
            <EnumSelect
              field={field}
              options={SERVICE_TYPES}
              getLabel={(v) => tEnums(`serviceTypes.${v}`)}
              disabled={!canManageServers}
            />
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name={`${role}ServiceName`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>{tForm("serviceName")}</FormLabel>
            <FormControl>
              <Input disabled={!canManageServers} {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent>
          <form
            onSubmit={form.handleSubmit(onSave)}
            className="flex flex-col gap-6"
          >
            {targets.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noTargets")}</p>
            ) : (
              targets.map((target, index) => (
                <section key={target.id} className="flex flex-col gap-4">
                  <TargetHeading target={target} />
                  {targetText(index, "sourceBranch")}
                  {targetSwitch(index, "autoDeploy")}
                </section>
              ))
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="env-server">{tForm("server")}</Label>
              <ServerSelect
                id="env-server"
                value={mixed ? "" : backendServerId}
                onChange={onServer}
                servers={pickerServers}
                disabled={locked || mixed}
              />
              {sharedDbElsewhere ? (
                <p role="alert" className="text-sm text-destructive">
                  {t("serverSharedDbElsewhere")}
                </p>
              ) : locked ? (
                <Hint>{t("serverLocked")}</Hint>
              ) : mixed ? (
                <Hint>
                  {t(canManageServers ? "serverMixed" : "serverMixedAdminOnly")}
                </Hint>
              ) : (
                <Hint>{t("serverHint")}</Hint>
              )}
            </div>

            <AdvancedOptions
              attempt={form.formState.submitCount}
              invalid={
                !!(
                  errors.targets ||
                  errors.backendServerId ||
                  errors.backendServiceName ||
                  errors.frontendServerId ||
                  errors.frontendServiceName
                )
              }
            >
              {targets.map((target, index) => (
                <section key={target.id} className="flex flex-col gap-4">
                  <TargetHeading target={target} />
                  <FormField
                    control={form.control}
                    name={`targets.${index}.serverId`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel htmlFor={`target-server-${index}`}>
                          {tTarget("server")}
                        </FormLabel>
                        <ServerSelect
                          id={`target-server-${index}`}
                          value={field.value}
                          onChange={field.onChange}
                          servers={targetServers}
                          disabled={!canConfigure}
                        />
                        <Hint>{tTarget("serverHint")}</Hint>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {targetText(index, "deployDir", {
                    placeholder: "/opt/dplk-accounting",
                  })}
                  {targetText(index, "services", {
                    placeholder: "backend, frontend",
                  })}
                  {targetText(index, "tagVariable")}
                  {targetText(index, "healthUrl", {
                    inputMode: "url",
                    placeholder: "http://localhost:8080/health",
                  })}
                  {targetText(index, "healthTimeoutSeconds", {
                    inputMode: "numeric",
                  })}
                  {targetText(index, "preStartCommand")}
                  {targetSwitch(index, "backupBeforeDeploy")}
                </section>
              ))}

              <section className="flex flex-col gap-4">
                <h3 className="text-sm font-medium">{tForm("backend")}</h3>
                {!canManageServers && <Hint>{tForm("infraReadOnlyHint")}</Hint>}
                {service("backend")}
              </section>

              <section className="flex flex-col gap-4">
                <h3 className="text-sm font-medium">{tForm("frontend")}</h3>
                <FormField
                  control={form.control}
                  name="hasFrontend"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center gap-2">
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            disabled={!canManageServers}
                          />
                        </FormControl>
                        <FormLabel className="font-normal">
                          {tForm("hasFrontend")}
                        </FormLabel>
                      </div>
                      <Hint>{tForm("hasFrontendHint")}</Hint>
                    </FormItem>
                  )}
                />
                {hasFrontend && service("frontend")}
              </section>

              <EnvFileManagedSwitch environment={environment} />

              {canConfigure && (
                <div className="flex flex-col items-start gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setAdding(true)}
                  >
                    <Plus data-icon="inline-start" />
                    {tDeploys("addTarget")}
                  </Button>
                  <Hint>{tTarget("createDescription")}</Hint>
                </div>
              )}
            </AdvancedOptions>

            <SaveButton disabled={sharedDbElsewhere} />
          </form>
        </CardContent>
      </Card>

      <TargetFormDialog
        open={adding}
        onOpenChange={setAdding}
        environment={environment}
        servers={targetServers}
      />
    </div>
  );
}

// The repository a target deploys, with its component key beside it.
function TargetHeading({ target }: { target: SettingsTarget }) {
  return (
    <h3 className="flex flex-wrap items-baseline gap-2 text-sm font-medium">
      <span className="font-mono">
        {target.repoFullName ?? target.componentKey}
      </span>
      {target.repoFullName && (
        <span className="font-mono text-xs font-normal text-muted-foreground">
          {target.componentKey}
        </span>
      )}
    </h3>
  );
}

// Whether deploys render the environment's `.env` (moved here from the
// Variables page). Saves on its own: the switch calls the API at once,
// with the same conflict checks (shared deploy dir, missing variables).
function EnvFileManagedSwitch({
  environment,
}: {
  environment: SettingsEnvironment;
}) {
  const t = useTranslations("variables");
  const errorText = useVariableErrorText();
  const canSwitch = useProjectCan({
    variable: ["write"],
    deploy: ["configure"],
  });
  const [busy, setBusy] = useState(false);

  async function onToggle(enabled: boolean) {
    setBusy(true);
    try {
      await setEnvFileManaged(environment.id, enabled);
      toast.success(t(enabled ? "managedOn" : "managedOff"));
    } catch (error) {
      const conflict = error instanceof ApiError && error.status === 409;
      const names = conflict ? missingRequiredNames(error.message) : null;
      toast.error(
        names
          ? t("missingRequired", { names: names.join(", ") })
          : conflict && error.message === SHARED_DEPLOY_DIR_MESSAGE
            ? t("sharedDeployDir")
            : errorText(error)
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Switch
          id="env-file-managed"
          checked={environment.envFileManaged}
          disabled={!canSwitch || busy}
          onCheckedChange={(checked) => void onToggle(checked)}
        />
        <Label htmlFor="env-file-managed">{t("managedTitle")}</Label>
      </div>
      <Hint>{t("managedDescription")}</Hint>
    </section>
  );
}
