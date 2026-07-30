"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { createEnvironment, updateEnvironment } from "@/actions/environments";
import { ProjectCreateDialog } from "@/components/project-create-dialog";
import { ServerCreateDialog } from "@/components/server-create-dialog";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";
import type {
  Project,
  SafeEnvironmentWithServers,
  Server,
} from "@/lib/db/schema";
import { backendService, dbService, frontendService } from "@/lib/services";

const SERVICE_TYPES = ["docker", "systemd", "kubernetes"] as const;
const DB_TYPES = ["postgres", "mssql"] as const;
const ENV_KINDS = ["qa", "dev", "release", "sandbox", "prod"] as const;
// Sentinel for the "unspecified" Select option (Select can't hold an empty value).
const KIND_NONE = "none";

type ServerRole = "db" | "backend" | "frontend";

type Mode =
  | { type: "create"; cloneFrom?: SafeEnvironmentWithServers }
  | { type: "edit"; environment: SafeEnvironmentWithServers };

export function EnvironmentForm({
  mode,
  servers: initialServers,
  projects: initialProjects,
  defaultProjectId,
}: {
  mode: Mode;
  servers: Server[];
  projects: Project[];
  // Preselected parent project for a fresh create (e.g. "New environment" from
  // a project overview). Ignored on edit/clone, which take the source's project.
  defaultProjectId?: string;
}) {
  const t = useTranslations("environmentForm");
  const tEnums = useTranslations("dashboard");
  const tKinds = useTranslations("environmentKinds");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [servers, setServers] = useState<Server[]>(initialServers);
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [dialogRole, setDialogRole] = useState<ServerRole | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);

  const schema = z
    .object({
      projectId: z.string().min(1, t("projectRequired")),
      name: z.string().min(1, tCommon("required")),
      // "" = unspecified (mapped to null on submit).
      kind: z.enum(ENV_KINDS).or(z.literal("")),
      owner: z.string(),

      dbServerId: z.string().min(1, t("pickServerRequired")),
      dbServiceType: z.enum(SERVICE_TYPES),
      dbServiceName: z.string().min(1, tCommon("required")),
      dbType: z.enum(DB_TYPES),
      dbName: z.string().min(1, tCommon("required")),
      // Empty string is valid here; superRefine enforces it for mssql on create.
      // On edit, empty means "keep the stored password" (handled in onSubmit).
      dbPassword: z.string(),
      dbBackupPath: z.string().min(1, tCommon("required")),

      backendServerId: z.string().min(1, t("pickServerRequired")),
      backendServiceType: z.enum(SERVICE_TYPES),
      backendServiceName: z.string().min(1, tCommon("required")),
      backendMockTimeApiUrl: z.union([
        z.string().trim().url(tCommon("urlInvalid")),
        z.literal(""),
      ]),
      // Empty string is allowed. On edit, empty means "keep the stored key"
      // (handled in onSubmit). On create, empty means no auth header is sent.
      backendMockTimeApiKey: z.string(),

      frontendServerId: z.string().min(1, t("pickServerRequired")),
      frontendServiceType: z.enum(SERVICE_TYPES),
      frontendServiceName: z.string().min(1, tCommon("required")),
    })
    .superRefine((data, ctx) => {
      // mssql needs an `sa` password for sqlcmd. On create, the field must be
      // filled. On edit, empty means "no change" — we only fail if there's no
      // stored password to fall back to (handled at submit time too, but
      // surface the error inline where possible).
      if (data.dbType !== "mssql") return;
      const hasStored =
        mode.type === "edit" && dbService(mode.environment).hasDbPassword;
      if (!data.dbPassword && !hasStored) {
        ctx.addIssue({
          code: "custom",
          message: t("dbPasswordRequiredForMssql"),
          path: ["dbPassword"],
        });
      }
    });

  type FormValues = z.infer<typeof schema>;

  const source =
    mode.type === "edit"
      ? mode.environment
      : mode.type === "create" && mode.cloneFrom
        ? mode.cloneFrom
        : null;

  const dbSvc = source ? dbService(source) : undefined;
  const backendSvc = source ? backendService(source) : undefined;
  const frontendSvc = source ? frontendService(source) : undefined;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: source
      ? {
          projectId: source.projectId,
          // On clone, suffix the source name to make it obvious the new environment
          // is a copy and to avoid duplicate-name confusion in the picker.
          name:
            mode.type === "create"
              ? t("nameCopySuffix", { name: source.name })
              : source.name,
          kind: source.kind ?? "",
          owner: source.owner ?? "",
          dbServerId: dbSvc?.serverId ?? "",
          dbServiceType: dbSvc?.serviceType ?? "docker",
          dbServiceName: dbSvc?.serviceName ?? "",
          dbType: dbSvc?.dbType ?? "postgres",
          dbName: dbSvc?.dbName ?? "",
          dbPassword: "",
          dbBackupPath: dbSvc?.dbBackupPath ?? "",
          backendServerId: backendSvc?.serverId ?? "",
          backendServiceType: backendSvc?.serviceType ?? "docker",
          backendServiceName: backendSvc?.serviceName ?? "",
          backendMockTimeApiUrl: backendSvc?.mockTimeApiUrl ?? "",
          backendMockTimeApiKey: "",
          frontendServerId: frontendSvc?.serverId ?? "",
          frontendServiceType: frontendSvc?.serviceType ?? "docker",
          frontendServiceName: frontendSvc?.serviceName ?? "",
        }
      : {
          projectId: defaultProjectId ?? initialProjects[0]?.id ?? "",
          name: "",
          kind: "",
          owner: "",
          dbServerId: initialServers[0]?.id ?? "",
          dbServiceType: "docker",
          dbServiceName: "",
          dbType: "postgres",
          dbName: "",
          dbPassword: "",
          dbBackupPath: "",
          backendServerId: initialServers[0]?.id ?? "",
          backendServiceType: "docker",
          backendServiceName: "",
          backendMockTimeApiUrl: "",
          backendMockTimeApiKey: "",
          frontendServerId: initialServers[0]?.id ?? "",
          frontendServiceType: "docker",
          frontendServiceName: "",
        },
  });

  function onServerCreated(server: Server) {
    setServers((prev) => [...prev, server]);
    if (dialogRole === "db") form.setValue("dbServerId", server.id);
    if (dialogRole === "backend") form.setValue("backendServerId", server.id);
    if (dialogRole === "frontend") form.setValue("frontendServerId", server.id);
  }

  function onProjectCreated(project: Project) {
    setProjects((prev) => [...prev, project]);
    form.setValue("projectId", project.id, { shouldValidate: true });
  }

  async function onSubmit(values: FormValues) {
    const { dbPassword, backendMockTimeApiKey, ...rest } = values;
    const base = {
      ...rest,
      backendMockTimeApiUrl: values.backendMockTimeApiUrl
        ? values.backendMockTimeApiUrl
        : null,
      // "" from the picker/input means "unset".
      kind: values.kind ? values.kind : null,
      owner: values.owner.trim() ? values.owner.trim() : null,
    };
    // On create: persist password (null for postgres). On edit: only include it
    // when the user typed something — empty means "keep stored value".
    const withPassword =
      mode.type === "create"
        ? {
            ...base,
            dbPassword: values.dbType === "mssql" ? dbPassword : null,
          }
        : dbPassword
          ? { ...base, dbPassword }
          : base;
    // Same edit semantics as dbPassword: blank = keep stored key. On create,
    // blank means "no auth" → persist null.
    const payload =
      mode.type === "create"
        ? {
            ...withPassword,
            backendMockTimeApiKey: backendMockTimeApiKey || null,
          }
        : backendMockTimeApiKey
          ? { ...withPassword, backendMockTimeApiKey }
          : withPassword;
    const result =
      mode.type === "create"
        ? await createEnvironment(payload)
        : await updateEnvironment(mode.environment.id, payload);

    if (!result.success || !result.data) {
      toast.error(result.message ?? t("submitFailed"));
      return;
    }

    toast.success(
      mode.type === "create" ? t("createdSuccess") : t("savedSuccess")
    );

    if (mode.type === "create") {
      // Land on the new environment's readable URL. The parent project's key
      // comes from the picker's own list — the created row only carries ids.
      const parentKey = projects.find(
        (p) => p.id === result.data?.projectId
      )?.key;
      if (parentKey) {
        router.push(`/${parentKey}/${result.data.slug}`);
      } else {
        router.push("/projects");
      }
    }
    router.refresh();
  }

  const loading = form.formState.isSubmitting;

  useUnsavedChanges(form.formState.isDirty && !loading);

  return (
    <>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-col gap-6"
        >
          <Section title={t("info")}>
            <FormField
              control={form.control}
              name="projectId"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>{t("project")}</FormLabel>
                  <div className="flex gap-2">
                    <Select
                      value={field.value || undefined}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger className="flex-1">
                          <SelectValue placeholder={t("pickProject")} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {projects.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                            <span className="ms-2 text-xs text-muted-foreground">
                              {p.key}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setProjectDialogOpen(true)}
                    >
                      <Plus className="size-4" />
                      <span className="hidden sm:inline">
                        {t("newProjectShort")}
                      </span>
                    </Button>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>{t("name")}</FormLabel>
                  <FormControl>
                    <Input placeholder={t("namePlaceholder")} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("kind")}</FormLabel>
                  <Select
                    value={field.value || KIND_NONE}
                    onValueChange={(v) =>
                      field.onChange(v === KIND_NONE ? "" : v)
                    }
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={KIND_NONE}>{t("kindNone")}</SelectItem>
                      {ENV_KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {tKinds(k)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t("kindHint")}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="owner"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("owner")}</FormLabel>
                  <FormControl>
                    <Input placeholder={t("ownerPlaceholder")} {...field} />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    {t("ownerHint")}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </Section>

          <Section title={t("database")}>
            <ServerPicker
              t={t}
              control={form.control}
              name="dbServerId"
              servers={servers}
              onRequestCreate={() => setDialogRole("db")}
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
                    <Input {...field} />
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
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="dbName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("dbName")}</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
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
                      placeholder={
                        mode.type === "edit"
                          ? t("dbPasswordEditPlaceholder")
                          : ""
                      }
                      {...field}
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    {t("dbPasswordHint")}
                  </p>
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
                    <Input placeholder="/var/backups/db" {...field} />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    {t("backupPathHint")}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </Section>

          <Section title={t("backend")}>
            <ServerPicker
              t={t}
              control={form.control}
              name="backendServerId"
              servers={servers}
              onRequestCreate={() => setDialogRole("backend")}
            />
            <FormField
              control={form.control}
              name="backendServiceType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("serviceType")}</FormLabel>
                  <EnumSelect
                    field={field}
                    options={SERVICE_TYPES}
                    getLabel={(v) => tEnums(`serviceTypes.${v}`)}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="backendServiceName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("serviceName")}</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="backendMockTimeApiUrl"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>{t("mockTimeApiUrl")}</FormLabel>
                  <FormControl>
                    <Input
                      type="url"
                      placeholder="https://api.example.com/v1/clock"
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    {t("mockTimeApiUrlHint")}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="backendMockTimeApiKey"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>{t("mockTimeApiKey")}</FormLabel>
                  <FormControl>
                    <PasswordInput
                      autoComplete="new-password"
                      placeholder={
                        mode.type === "edit" &&
                        backendService(mode.environment).hasMockTimeApiKey
                          ? t("mockTimeApiKeyEditPlaceholder")
                          : ""
                      }
                      {...field}
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    {t("mockTimeApiKeyHint")}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </Section>

          <Section title={t("frontend")}>
            <ServerPicker
              t={t}
              control={form.control}
              name="frontendServerId"
              servers={servers}
              onRequestCreate={() => setDialogRole("frontend")}
            />
            <FormField
              control={form.control}
              name="frontendServiceType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("serviceType")}</FormLabel>
                  <EnumSelect
                    field={field}
                    options={SERVICE_TYPES}
                    getLabel={(v) => tEnums(`serviceTypes.${v}`)}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="frontendServiceName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("serviceName")}</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </Section>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.back()}
              disabled={loading}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading
                ? t("submitting")
                : mode.type === "edit"
                  ? t("saveChanges")
                  : t("submit")}
            </Button>
          </div>
        </form>
      </Form>

      <ServerCreateDialog
        open={dialogRole !== null}
        onOpenChange={(open) => {
          if (!open) setDialogRole(null);
        }}
        onCreated={onServerCreated}
      />

      <ProjectCreateDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        onCreated={onProjectCreated}
      />
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        {title}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

// A form-bound shadcn Select for a fixed set of string options. Wraps the
// trigger in FormControl so RHF field state (id, aria-invalid) is applied.
function EnumSelect({
  field,
  options,
  getLabel,
  placeholder,
}: {
  field: {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
  };
  options: readonly string[];
  getLabel: (value: string) => string;
  placeholder?: string;
}) {
  return (
    <Select
      value={field.value}
      onValueChange={(v) => field.onChange(v ?? "")}
      disabled={field.disabled}
    >
      <FormControl>
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

function ServerPicker({
  t,
  control,
  name,
  servers,
  onRequestCreate,
}: {
  t: (key: string) => string;
  // biome-ignore lint/suspicious/noExplicitAny: control type is generic over form values
  control: any;
  name: string;
  servers: Server[];
  onRequestCreate: () => void;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="sm:col-span-2">
          <FormLabel>{t("server")}</FormLabel>
          <div className="flex gap-2">
            <Select
              value={field.value || undefined}
              onValueChange={field.onChange}
            >
              <FormControl>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder={t("pickServer")} />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {servers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} ({s.host})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" onClick={onRequestCreate}>
              <Plus className="size-4" />
              <span className="hidden sm:inline">{t("newServerShort")}</span>
            </Button>
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
