import { useRef } from "react";
import {
  type FieldPath,
  type UseFormReturn,
  useForm,
  useFormContext,
} from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { FormControl } from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import type {
  Project as ProjectRow,
  SafeEnvironmentWithServers,
} from "@/lib/db/schema";
import { TAG_VARIABLE_IS_VARIABLE_MESSAGE } from "@/lib/deploy/errors";
import type { DB_KINDS } from "@/lib/environment-database-binding";
import { buildEnvironmentPayload } from "@/lib/environment-submit-payload";
import { backendService, findService } from "@/lib/services";
import { sharedDatabaseNameSchema } from "@/lib/validation";
import { ApiError, type Serialized } from "@/web/api/client";
import { type DeployTargetState, updateDeployTarget } from "@/web/api/deploys";
import { updateEnvironment } from "@/web/api/environments";
import {
  type TargetValues,
  targetFormValues,
  targetSettings,
  useTargetSchema,
} from "../deploys/target-form-dialog";

export const SERVICE_TYPES = ["docker", "systemd", "kubernetes"] as const;
export const DB_TYPES = ["postgres", "mssql", "mysql"] as const;
// Engines the panel logs into over TCP, so they need a user + password.
const TCP_AUTH_DB_TYPES = new Set<string>(["mssql", "mysql"]);
export const ENV_KINDS = ["qa", "dev", "release", "sandbox", "prod"] as const;
const HTTP_URL = z.url({ protocol: /^https?$/ });

type ServiceType = (typeof SERVICE_TYPES)[number];

// `host` is present only for callers allowed to read servers.
export type ServerOption = { id: string; name: string; host?: string };
export type SettingsEnvironment = Serialized<SafeEnvironmentWithServers>;
export type SettingsProject = Serialized<ProjectRow>;

export type SettingsTarget = TargetValues & {
  id: string;
  componentKey: string;
};

/**
 * The whole page's state: every environment field the update payload carries
 * ("" = unset), plus the deploy targets. Each tab validates and saves its own
 * fields; the rest of the payload comes from the last saved values, so a save
 * never sends another tab's unsaved edits.
 */
export type SettingsValues = {
  projectId: string;
  name: string;
  kind: (typeof ENV_KINDS)[number] | "";
  ownerId: string;
  url: string;
  hasDatabase: boolean;
  hasFrontend: boolean;
  dbServerId: string;
  dbServiceType: ServiceType;
  dbServiceName: string;
  dbType: (typeof DB_TYPES)[number];
  dbName: string;
  dbUser: string;
  // Blank = keep the stored password.
  dbPassword: string;
  dbBackupPath: string;
  dbKind: (typeof DB_KINDS)[number] | "";
  databaseHostId: string;
  dbRole: string;
  dbPasswordVariable: string;
  backendServerId: string;
  backendServiceType: ServiceType;
  backendServiceName: string;
  backendMockTimeApiUrl: string;
  // Blank = keep the stored key.
  backendMockTimeApiKey: string;
  frontendServerId: string;
  frontendServiceType: ServiceType;
  frontendServiceName: string;
  targets: SettingsTarget[];
};

export type SettingsTab = "general" | "source" | "database" | "mail";

type FieldName = Exclude<keyof SettingsValues, "targets">;

// The fields each tab edits. The database server and service live on the
// Database tab; the one server picker of Source & Deploy moves them too.
const TAB_FIELDS: Record<SettingsTab, FieldName[]> = {
  general: ["projectId", "name", "kind", "ownerId", "url"],
  source: [
    "backendServerId",
    "backendServiceType",
    "backendServiceName",
    "hasFrontend",
    "frontendServerId",
    "frontendServiceType",
    "frontendServiceName",
    "dbServerId",
  ],
  database: [
    "hasDatabase",
    "dbKind",
    "dbName",
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
  ],
  mail: ["backendMockTimeApiUrl", "backendMockTimeApiKey"],
};

export function settingsValues(
  environment: SettingsEnvironment,
  targets: DeployTargetState[]
): SettingsValues {
  const db = findService(environment, "db");
  const backend = backendService(environment);
  const frontend = findService(environment, "frontend");
  return {
    projectId: environment.projectId,
    name: environment.name,
    kind: environment.kind ?? "",
    ownerId: environment.ownerId ?? "",
    url: environment.url ?? "",
    // The stored services: a missing row is a switched-off service.
    hasDatabase: !!db,
    hasFrontend: !!frontend,
    dbServerId: db?.serverId ?? "",
    dbServiceType: db?.serviceType ?? "docker",
    dbServiceName: db?.serviceName ?? "",
    dbType: db?.dbType ?? "postgres",
    dbName: db?.dbName ?? "",
    dbUser: db?.dbUser ?? "",
    dbPassword: "",
    dbBackupPath: db?.dbBackupPath ?? "",
    dbKind: db?.dbKind ?? "",
    databaseHostId: db?.databaseHostId ?? "",
    dbRole: db?.dbRole ?? "",
    dbPasswordVariable: db?.dbPasswordVariable ?? "",
    backendServerId: backend?.serverId ?? "",
    backendServiceType: backend?.serviceType ?? "docker",
    backendServiceName: backend?.serviceName ?? "",
    backendMockTimeApiUrl: backend?.mockTimeApiUrl ?? "",
    backendMockTimeApiKey: "",
    frontendServerId: frontend?.serverId ?? "",
    frontendServiceType: frontend?.serviceType ?? "docker",
    frontendServiceName: frontend?.serviceName ?? "",
    targets: targets.map((target) => ({
      id: target.id,
      componentKey: target.componentKey,
      ...targetFormValues(target, []),
    })),
  };
}

const INFO_FIELDS = ["projectId", "name", "kind", "ownerId", "url"] as const;
const SERVER_FIELDS = [
  "backendServerId",
  "frontendServerId",
  "dbServerId",
] as const;

/**
 * The update payload. With org server:manage it is the full payload (secrets
 * only when typed). Without it, the info fields plus the server ids that
 * changed: the only bindings such a caller may rebind (before the first
 * deploy), and re-sent stored bindings must not count as edits.
 */
export function environmentPayload(
  values: SettingsValues,
  saved: SettingsValues,
  canManageServers: boolean
) {
  const { targets: _targets, ...environment } = values;
  const full = buildEnvironmentPayload(environment, "edit");
  if (canManageServers) return full;
  const info = Object.fromEntries(INFO_FIELDS.map((f) => [f, full[f]]));
  const servers = Object.fromEntries(
    SERVER_FIELDS.filter((f) => f in full && values[f] !== saved[f]).map(
      (f) => [f, values[f]]
    )
  );
  return { ...info, ...servers } as Partial<typeof full>;
}

// The settings each changed target sends: only the fields that differ.
function targetChanges(next: SettingsTarget, saved: SettingsTarget) {
  const after = targetSettings(next);
  const before = targetSettings(saved);
  return Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) =>
        JSON.stringify(value) !==
        JSON.stringify(before[key as keyof typeof before])
    )
  ) as Partial<typeof after>;
}

function useTabSchemas(environment: SettingsEnvironment) {
  const t = useTranslations("environmentForm");
  const tCommon = useTranslations("common");
  const required = tCommon("required");
  const targetSchema = useTargetSchema();
  const requireFields = (
    data: Record<string, unknown>,
    ctx: z.RefinementCtx,
    fields: string[],
    message: string
  ) => {
    for (const field of fields) {
      if (!data[field])
        ctx.addIssue({ code: "custom", message, path: [field] });
    }
  };
  return {
    general: z.object({
      projectId: z.string().min(1, t("projectRequired")),
      name: z.string().trim().min(1, required),
      url: z
        .string()
        .trim()
        .max(2048)
        .refine((v) => !v || HTTP_URL.safeParse(v).success, t("urlInvalid")),
    }),
    source: z
      .object({
        backendServerId: z.string().min(1, t("pickServerRequired")),
        backendServiceName: z.string().trim().min(1, required),
        hasFrontend: z.boolean(),
        frontendServerId: z.string(),
        frontendServiceName: z.string(),
        targets: z.array(targetSchema),
      })
      .superRefine((data, ctx) => {
        if (!data.hasFrontend) return;
        requireFields(data, ctx, ["frontendServerId"], t("pickServerRequired"));
        requireFields(data, ctx, ["frontendServiceName"], required);
      }),
    database: z
      .object({
        hasDatabase: z.boolean(),
        dbKind: z.string(),
        dbServerId: z.string(),
        dbServiceName: z.string(),
        dbType: z.string(),
        dbName: z.string(),
        dbPassword: z.string(),
        dbBackupPath: z.string(),
        databaseHostId: z.string(),
        dbRole: z.string(),
        dbPasswordVariable: z.string(),
      })
      .superRefine((data, ctx) => {
        if (!data.hasDatabase) return;
        if (data.dbKind === "shared") {
          // The host supplies server, container, engine and backup path.
          requireFields(
            data,
            ctx,
            ["databaseHostId"],
            t("pickDatabaseHostRequired")
          );
          requireFields(
            data,
            ctx,
            ["dbName", "dbRole", "dbPasswordVariable"],
            required
          );
          for (const field of ["dbName", "dbRole"] as const) {
            if (
              data[field] &&
              !sharedDatabaseNameSchema.safeParse(data[field]).success
            ) {
              ctx.addIssue({
                code: "custom",
                message: t("sharedNameInvalid"),
                path: [field],
              });
            }
          }
          return;
        }
        requireFields(data, ctx, ["dbServerId"], t("pickServerRequired"));
        requireFields(
          data,
          ctx,
          ["dbServiceName", "dbName", "dbBackupPath"],
          required
        );
        // The TCP-auth engines need a password; blank keeps the stored one.
        const hasStored = !!findService(environment, "db")?.hasDbPassword;
        if (
          TCP_AUTH_DB_TYPES.has(data.dbType) &&
          !data.dbPassword &&
          !hasStored
        )
          ctx.addIssue({
            code: "custom",
            message: t("dbPasswordRequired"),
            path: ["dbPassword"],
          });
      }),
    mail: z.object({
      backendMockTimeApiUrl: z.union([
        z.string().trim().url(tCommon("urlInvalid")),
        z.literal(""),
      ]),
    }),
  } satisfies Record<SettingsTab, z.ZodType>;
}

/**
 * One form for the whole Settings page; `saveTab` validates one tab's fields
 * and sends the full environment payload with every other field at its last
 * saved value. Source & Deploy then saves the deploy targets that changed.
 */
export function useSettingsForm(
  environment: SettingsEnvironment,
  targets: DeployTargetState[],
  canManageServers: boolean
) {
  const t = useTranslations("environmentForm");
  const tDeploys = useTranslations("deploys.form");
  const tCommon = useTranslations("common");
  const schemas = useTabSchemas(environment);
  const initial = settingsValues(environment, targets);
  const saved = useRef<SettingsValues>(initial);
  const form = useForm<SettingsValues>({ defaultValues: initial });
  useUnsavedChanges(form.formState.isDirty && !form.formState.isSubmitting);

  // A failed target save keeps that target's edits dirty.
  async function saveTargets(values: SettingsValues): Promise<boolean> {
    let ok = true;
    for (const [index, target] of values.targets.entries()) {
      const before = saved.current.targets.find((s) => s.id === target.id);
      if (!before) continue;
      const changes = targetChanges(target, before);
      if (Object.keys(changes).length === 0) continue;
      try {
        await updateDeployTarget(target.id, changes);
        saved.current = {
          ...saved.current,
          targets: saved.current.targets.map((s) =>
            s.id === target.id ? target : s
          ),
        };
        form.resetField(`targets.${index}`, { defaultValue: target });
      } catch (error) {
        ok = false;
        if (
          error instanceof ApiError &&
          error.message === TAG_VARIABLE_IS_VARIABLE_MESSAGE
        ) {
          form.setError(`targets.${index}.tagVariable`, {
            message: tDeploys("tagVariableIsVariable"),
          });
        } else {
          toast.error(
            error instanceof Error ? error.message : tCommon("errorGeneric")
          );
        }
      }
    }
    return ok;
  }

  async function saveTab(tab: SettingsTab): Promise<void> {
    const fields = TAB_FIELDS[tab];
    const values = form.getValues();
    form.clearErrors([
      ...fields,
      ...(tab === "source" ? (["targets"] as const) : []),
    ]);
    const parsed = schemas[tab].safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        form.setError(issue.path.join(".") as FieldPath<SettingsValues>, {
          message: issue.message,
        });
      }
      return;
    }
    const tabValues = Object.fromEntries(
      fields.map((field) => [field, values[field]])
    ) as Partial<SettingsValues>;
    // The server must know a newly bound server before a target moves onto it,
    // so the environment is saved first.
    const result = await updateEnvironment(
      environment.id,
      environmentPayload(
        { ...saved.current, ...tabValues },
        saved.current,
        canManageServers
      )
    );
    if (!result.success || !result.data) {
      toast.error(result.message ?? t("submitFailed"));
      return;
    }
    // Re-baseline the saved fields; secrets go back to blank ("keep").
    saved.current = {
      ...saved.current,
      ...tabValues,
      dbPassword: "",
      backendMockTimeApiKey: "",
    };
    for (const field of fields) {
      form.resetField(field, { defaultValue: saved.current[field] });
    }
    if (tab === "source" && !(await saveTargets(values))) return;
    toast.success(t("savedSuccess"));
  }

  return { form, saveTab };
}

export function useSettingsFormContext() {
  return useFormContext<SettingsValues>();
}

export type SettingsForm = UseFormReturn<SettingsValues>;

/** A tab's save button; submitting runs the tab's save. */
export function SaveButton() {
  const t = useTranslations("environmentForm");
  const { formState } = useSettingsFormContext();
  return (
    <div className="flex justify-end">
      <Button type="submit" disabled={formState.isSubmitting}>
        {formState.isSubmitting ? t("submitting") : t("saveChanges")}
      </Button>
    </div>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

// A form-bound Select for a fixed set of string options.
export function EnumSelect({
  field,
  options,
  getLabel,
  placeholder,
  disabled,
  id,
}: {
  field: { value: string; onChange: (value: string) => void };
  options: readonly string[];
  getLabel: (value: string) => string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Select
      value={field.value || null}
      onValueChange={(v) => field.onChange(v ?? "")}
      disabled={disabled}
    >
      <FormControl {...(id ? { id } : {})}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
      </FormControl>
      <SelectContent>
        {options.map((v) => (
          <SelectItem key={v} value={v}>
            {getLabel(v)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * A server select. `data-server-select` marks every server picker on the page
 * (the simple one and the per-service ones under Advanced options).
 */
export function ServerSelect({
  id,
  value,
  onChange,
  servers,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  servers: ServerOption[];
  disabled?: boolean;
}) {
  const t = useTranslations("environmentForm");
  return (
    <Select
      value={value || null}
      onValueChange={(v) => onChange(v ?? "")}
      disabled={disabled}
    >
      <SelectTrigger id={id} data-server-select="" className="w-full">
        <SelectValue placeholder={t("pickServer")} />
      </SelectTrigger>
      <SelectContent>
        {servers.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.host ? `${s.name} (${s.host})` : s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The servers a picker offers: the caller's options plus the servers the
 * environment is bound to now (which an engineer's options may lack).
 */
export function serverOptions(
  environment: SettingsEnvironment,
  servers: ServerOption[]
): ServerOption[] {
  const byId = new Map(servers.map((s) => [s.id, s]));
  for (const service of environment.services) {
    if (!byId.has(service.server.id)) {
      byId.set(service.server.id, {
        id: service.server.id,
        name: service.server.name,
      });
    }
  }
  return [...byId.values()];
}
