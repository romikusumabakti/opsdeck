import { useQuery } from "@tanstack/react-query";
import { useWatch } from "react-hook-form";
import { useTranslations } from "use-intl";
import { AdvancedOptions } from "@/components/advanced-options";
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
import { PasswordInput } from "@/components/ui/password-input";
import {
  DB_KINDS,
  suggestSharedDbName,
} from "@/lib/environment-database-binding";
import { dbAdminUser } from "@/lib/services";
import { listDatabaseHostsQuery } from "@/web/api/database-hosts";
import { listVariablesQuery } from "@/web/api/variables";
import {
  DB_TYPES,
  EnumSelect,
  Hint,
  SaveButton,
  SERVICE_TYPES,
  type ServerOption,
  ServerSelect,
  type SettingsEnvironment,
  useSettingsFormContext,
} from "./settings-form";

// "No database" in the kind picker: the db service is switched off.
const NONE = "none";
const KIND_OPTIONS = [NONE, ...DB_KINDS] as const;
const ADVANCED_FIELDS = [
  "dbServerId",
  "dbServiceType",
  "dbServiceName",
  "dbType",
  "dbUser",
  "dbPassword",
  "dbBackupPath",
  "databaseHostId",
  "dbRole",
  "dbPasswordVariable",
] as const;

/**
 * Where the database lives (none / shared / container / external) and its
 * name; every other database field is under Advanced options. Editing needs
 * org server:manage; without it the tab is read-only.
 */
export function DatabaseTab({
  environment,
  servers,
  projectKey,
  canManageServers,
  onSave,
}: {
  environment: SettingsEnvironment;
  servers: ServerOption[];
  projectKey: string;
  canManageServers: boolean;
  onSave: () => Promise<void>;
}) {
  const t = useTranslations("environmentForm");
  const tSettings = useTranslations("environmentSettings");
  const tEnums = useTranslations("dashboard");
  const form = useSettingsFormContext();
  const { errors } = form.formState;
  const readOnly = !canManageServers;
  const [hasDatabase, dbKind, dbType] = useWatch({
    control: form.control,
    name: ["hasDatabase", "dbKind", "dbType"],
  });
  const shared = hasDatabase && dbKind === "shared";

  function onKind(value: string) {
    const opts = { shouldDirty: true } as const;
    if (value === NONE) {
      form.setValue("hasDatabase", false, opts);
      return;
    }
    form.setValue("hasDatabase", true, opts);
    form.setValue("dbKind", value as (typeof DB_KINDS)[number], opts);
    // A database of its own starts on the environment's server.
    if (value !== "shared" && !form.getValues("dbServerId")) {
      form.setValue("dbServerId", form.getValues("backendServerId"), opts);
    }
  }

  return (
    <Card>
      <CardContent>
        <form
          onSubmit={form.handleSubmit(onSave)}
          className="flex flex-col gap-6"
        >
          {readOnly && <Hint>{t("infraReadOnlyHint")}</Hint>}
          <FormField
            control={form.control}
            name="dbKind"
            render={() => (
              <FormItem>
                <FormLabel>{t("dbKind")}</FormLabel>
                <EnumSelect
                  field={{
                    value: hasDatabase ? dbKind : NONE,
                    onChange: onKind,
                  }}
                  options={KIND_OPTIONS}
                  getLabel={(v) =>
                    v === NONE ? tSettings("noDatabase") : t(`dbKinds.${v}`)
                  }
                  placeholder={t("dbKindNone")}
                  disabled={readOnly}
                />
                <Hint>{t("dbKindHint")}</Hint>
                <FormMessage />
              </FormItem>
            )}
          />

          {hasDatabase && (
            <>
              <FormField
                control={form.control}
                name="dbName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("dbName")}</FormLabel>
                    <FormControl>
                      <Input
                        className="font-mono"
                        disabled={readOnly}
                        placeholder={
                          shared
                            ? suggestSharedDbName(projectKey, environment.slug)
                            : undefined
                        }
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <AdvancedOptions
                invalid={ADVANCED_FIELDS.some((field) => errors[field])}
              >
                {shared ? (
                  <SharedDatabaseFields
                    environment={environment}
                    projectKey={projectKey}
                    readOnly={readOnly}
                  />
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="dbServerId"
                      render={({ field }) => (
                        <FormItem className="sm:col-span-2">
                          <FormLabel htmlFor="server-db">
                            {t("server")}
                          </FormLabel>
                          <ServerSelect
                            id="server-db"
                            value={field.value}
                            onChange={field.onChange}
                            servers={servers}
                            disabled={readOnly}
                          />
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="dbServiceType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("serviceType")}</FormLabel>
                          <EnumSelect
                            field={field}
                            options={SERVICE_TYPES}
                            getLabel={(v) => tEnums(`serviceTypes.${v}`)}
                            disabled={readOnly}
                          />
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="dbServiceName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("serviceName")}</FormLabel>
                          <FormControl>
                            <Input disabled={readOnly} {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="dbType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("dbType")}</FormLabel>
                          <EnumSelect
                            field={field}
                            options={DB_TYPES}
                            getLabel={(v) => tEnums(`dbTypes.${v}`)}
                            disabled={readOnly}
                          />
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="dbUser"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("dbUser")}</FormLabel>
                          <FormControl>
                            {/* The placeholder shows the account used when
                                the field is left blank. */}
                            <Input
                              autoComplete="off"
                              disabled={readOnly}
                              placeholder={dbAdminUser(dbType, null)}
                              {...field}
                            />
                          </FormControl>
                          <Hint>{t("dbUserHint")}</Hint>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="dbPassword"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("dbPassword")}</FormLabel>
                          <FormControl>
                            <PasswordInput
                              autoComplete="new-password"
                              disabled={readOnly}
                              placeholder={t("dbPasswordEditPlaceholder")}
                              {...field}
                            />
                          </FormControl>
                          <Hint>{t("dbPasswordHint")}</Hint>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="dbBackupPath"
                      render={({ field }) => (
                        <FormItem className="sm:col-span-2">
                          <FormLabel>{t("backupPath")}</FormLabel>
                          <FormControl>
                            <Input
                              disabled={readOnly}
                              placeholder="/var/backups/db"
                              {...field}
                            />
                          </FormControl>
                          <Hint>{t("backupPathHint")}</Hint>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}
              </AdvancedOptions>
            </>
          )}

          {!readOnly && <SaveButton />}
        </form>
      </CardContent>
    </Card>
  );
}

// A shared database lives in a registered database host, which supplies the
// server, container, engine and backup path; the tab asks only for the host,
// the role name and the variable holding the role's password.
function SharedDatabaseFields({
  environment,
  projectKey,
  readOnly,
}: {
  environment: SettingsEnvironment;
  projectKey: string;
  readOnly: boolean;
}) {
  const t = useTranslations("environmentForm");
  const form = useSettingsFormContext();
  const hosts = useQuery(listDatabaseHostsQuery()).data ?? [];
  const variables = useQuery(listVariablesQuery(environment.id)).data
    ?.variables;
  const suggestion = suggestSharedDbName(projectKey, environment.slug);
  // Only generated or secret variables can carry a role password. A stored
  // name the list lacks stays selectable.
  const stored = useWatch({
    control: form.control,
    name: "dbPasswordVariable",
  });
  const names = [
    ...new Set([
      ...(variables ?? [])
        .filter((v) => v.kind === "generated" || v.kind === "secret")
        .map((v) => v.name),
      ...(stored ? [stored] : []),
    ]),
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField
        control={form.control}
        name="databaseHostId"
        render={({ field }) => (
          <FormItem className="sm:col-span-2">
            <FormLabel>{t("databaseHost")}</FormLabel>
            <EnumSelect
              field={field}
              options={hosts.map((h) => h.id)}
              getLabel={(id) => {
                const host = hosts.find((h) => h.id === id);
                return host ? `${host.label} (${host.containerName})` : id;
              }}
              placeholder={t("pickDatabaseHost")}
              disabled={readOnly}
            />
            <Hint>{t("databaseHostHint")}</Hint>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="dbRole"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("dbRole")}</FormLabel>
            <FormControl>
              <Input
                className="font-mono"
                disabled={readOnly}
                placeholder={suggestion}
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="dbPasswordVariable"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("dbPasswordVariable")}</FormLabel>
            <EnumSelect
              field={field}
              options={names}
              getLabel={(v) => v}
              placeholder={t("pickPasswordVariable")}
              disabled={readOnly}
            />
            <Hint>{t("dbPasswordVariableHint")}</Hint>
            <FormMessage />
          </FormItem>
        )}
      />
      <div className="flex items-center justify-between gap-3 sm:col-span-2">
        <Hint>{t("sharedNameHint")}</Hint>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={readOnly}
          onClick={() => {
            form.setValue("dbName", suggestion, { shouldDirty: true });
            form.setValue("dbRole", suggestion, { shouldDirty: true });
          }}
        >
          {t("useSuggestedNames")}
        </Button>
      </div>
    </div>
  );
}
