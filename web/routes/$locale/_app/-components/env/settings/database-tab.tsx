import { useQuery } from "@tanstack/react-query";
import { Controller, useWatch } from "react-hook-form";
import { useTranslations } from "use-intl";
import { AdvancedOptions } from "@/components/advanced-options";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import {
  DB_KINDS,
  suggestSharedDbName,
} from "@/lib/environment-database-binding";
import { dbAdminUser } from "@/lib/services";
import { listDatabaseHostsQuery } from "@/web/api/database-hosts";
import { listVariablesQuery } from "@/web/api/variables";
import { EnumSelect, Hint, SaveButton, ServerSelect } from "./fields";
import {
  DB_TYPES,
  SERVICE_TYPES,
  type ServerOption,
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
        <form onSubmit={form.handleSubmit(onSave)}>
          <FieldGroup>
            {readOnly && <Hint>{t("infraReadOnlyHint")}</Hint>}
            <Controller
              name="dbKind"
              control={form.control}
              render={({ fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="env-db-kind">{t("dbKind")}</FieldLabel>
                  <EnumSelect
                    id="env-db-kind"
                    invalid={fieldState.invalid}
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
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            {hasDatabase && (
              <>
                <Controller
                  name="dbName"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="env-db-name">
                        {t("dbName")}
                      </FieldLabel>
                      <Input
                        className="font-mono"
                        disabled={readOnly}
                        placeholder={
                          shared
                            ? suggestSharedDbName(projectKey, environment.slug)
                            : undefined
                        }
                        {...field}
                        id="env-db-name"
                        aria-invalid={fieldState.invalid}
                      />
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
                <AdvancedOptions
                  attempt={form.formState.submitCount}
                  invalid={ADVANCED_FIELDS.some((field) => errors[field])}
                >
                  {shared ? (
                    <SharedDatabaseFields
                      environment={environment}
                      projectKey={projectKey}
                      readOnly={readOnly}
                    />
                  ) : (
                    <FieldGroup className="grid gap-4 sm:grid-cols-2">
                      <Controller
                        name="dbServerId"
                        control={form.control}
                        render={({ field, fieldState }) => (
                          <Field
                            className="sm:col-span-2"
                            data-invalid={fieldState.invalid}
                          >
                            <FieldLabel htmlFor="server-db">
                              {t("server")}
                            </FieldLabel>
                            <ServerSelect
                              id="server-db"
                              value={field.value}
                              onChange={field.onChange}
                              servers={servers}
                              disabled={readOnly}
                              invalid={fieldState.invalid}
                            />
                            <FieldError errors={[fieldState.error]} />
                          </Field>
                        )}
                      />
                      <Controller
                        name="dbServiceType"
                        control={form.control}
                        render={({ field, fieldState }) => (
                          <Field data-invalid={fieldState.invalid}>
                            <FieldLabel htmlFor="env-db-service-type">
                              {t("serviceType")}
                            </FieldLabel>
                            <EnumSelect
                              id="env-db-service-type"
                              invalid={fieldState.invalid}
                              field={field}
                              options={SERVICE_TYPES}
                              getLabel={(v) => tEnums(`serviceTypes.${v}`)}
                              disabled={readOnly}
                            />
                            <FieldError errors={[fieldState.error]} />
                          </Field>
                        )}
                      />
                      <Controller
                        name="dbServiceName"
                        control={form.control}
                        render={({ field, fieldState }) => (
                          <Field data-invalid={fieldState.invalid}>
                            <FieldLabel htmlFor="env-db-service-name">
                              {t("serviceName")}
                            </FieldLabel>
                            <Input
                              disabled={readOnly}
                              {...field}
                              id="env-db-service-name"
                              aria-invalid={fieldState.invalid}
                            />
                            <FieldError errors={[fieldState.error]} />
                          </Field>
                        )}
                      />
                      <Controller
                        name="dbType"
                        control={form.control}
                        render={({ field, fieldState }) => (
                          <Field data-invalid={fieldState.invalid}>
                            <FieldLabel htmlFor="env-db-type">
                              {t("dbType")}
                            </FieldLabel>
                            <EnumSelect
                              id="env-db-type"
                              invalid={fieldState.invalid}
                              field={field}
                              options={DB_TYPES}
                              getLabel={(v) => tEnums(`dbTypes.${v}`)}
                              disabled={readOnly}
                            />
                            <FieldError errors={[fieldState.error]} />
                          </Field>
                        )}
                      />
                      <Controller
                        name="dbUser"
                        control={form.control}
                        render={({ field, fieldState }) => (
                          <Field data-invalid={fieldState.invalid}>
                            <FieldLabel htmlFor="env-db-user">
                              {t("dbUser")}
                            </FieldLabel>
                            {/* The placeholder shows the account used when
                                the field is left blank. */}
                            <Input
                              autoComplete="off"
                              disabled={readOnly}
                              placeholder={dbAdminUser(dbType, null)}
                              {...field}
                              id="env-db-user"
                              aria-invalid={fieldState.invalid}
                            />
                            <Hint>{t("dbUserHint")}</Hint>
                            <FieldError errors={[fieldState.error]} />
                          </Field>
                        )}
                      />
                      <Controller
                        name="dbPassword"
                        control={form.control}
                        render={({ field, fieldState }) => (
                          <Field data-invalid={fieldState.invalid}>
                            <FieldLabel htmlFor="env-db-password">
                              {t("dbPassword")}
                            </FieldLabel>
                            <PasswordInput
                              autoComplete="new-password"
                              disabled={readOnly}
                              placeholder={t("dbPasswordEditPlaceholder")}
                              {...field}
                              id="env-db-password"
                              aria-invalid={fieldState.invalid}
                            />
                            <Hint>{t("dbPasswordHint")}</Hint>
                            <FieldError errors={[fieldState.error]} />
                          </Field>
                        )}
                      />
                      <Controller
                        name="dbBackupPath"
                        control={form.control}
                        render={({ field, fieldState }) => (
                          <Field
                            className="sm:col-span-2"
                            data-invalid={fieldState.invalid}
                          >
                            <FieldLabel htmlFor="env-db-backup-path">
                              {t("backupPath")}
                            </FieldLabel>
                            <Input
                              disabled={readOnly}
                              placeholder="/var/backups/db"
                              {...field}
                              id="env-db-backup-path"
                              aria-invalid={fieldState.invalid}
                            />
                            <Hint>{t("backupPathHint")}</Hint>
                            <FieldError errors={[fieldState.error]} />
                          </Field>
                        )}
                      />
                    </FieldGroup>
                  )}
                </AdvancedOptions>
              </>
            )}

            {!readOnly && <SaveButton />}
          </FieldGroup>
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
    <FieldGroup className="grid gap-4 sm:grid-cols-2">
      <Controller
        name="databaseHostId"
        control={form.control}
        render={({ field, fieldState }) => (
          <Field className="sm:col-span-2" data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor="env-database-host">
              {t("databaseHost")}
            </FieldLabel>
            <EnumSelect
              id="env-database-host"
              invalid={fieldState.invalid}
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
            <FieldError errors={[fieldState.error]} />
          </Field>
        )}
      />
      <Controller
        name="dbRole"
        control={form.control}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor="env-db-role">{t("dbRole")}</FieldLabel>
            <Input
              className="font-mono"
              disabled={readOnly}
              placeholder={suggestion}
              {...field}
              id="env-db-role"
              aria-invalid={fieldState.invalid}
            />
            <FieldError errors={[fieldState.error]} />
          </Field>
        )}
      />
      <Controller
        name="dbPasswordVariable"
        control={form.control}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor="env-db-password-variable">
              {t("dbPasswordVariable")}
            </FieldLabel>
            <EnumSelect
              id="env-db-password-variable"
              invalid={fieldState.invalid}
              field={field}
              options={names}
              getLabel={(v) => v}
              placeholder={t("pickPasswordVariable")}
              disabled={readOnly}
            />
            <Hint>{t("dbPasswordVariableHint")}</Hint>
            <FieldError errors={[fieldState.error]} />
          </Field>
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
    </FieldGroup>
  );
}
