"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { createProject, updateProject } from "@/actions/projects";
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
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";
import type { Project, Server } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

const SERVICE_TYPES = ["docker", "systemd", "kubernetes"] as const;
const DB_TYPES = ["postgres", "mssql"] as const;

type ServerRole = "db" | "backend" | "frontend";

type Mode =
  | { type: "create"; cloneFrom?: Project }
  | { type: "edit"; project: Project };

export function ProjectForm({
  mode,
  servers: initialServers,
}: {
  mode: Mode;
  servers: Server[];
}) {
  const t = useTranslations("projectForm");
  const tEnums = useTranslations("dashboard");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [servers, setServers] = useState<Server[]>(initialServers);
  const [dialogRole, setDialogRole] = useState<ServerRole | null>(null);

  const schema = z
    .object({
      name: z.string().min(1, tCommon("required")),

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
        mode.type === "edit" && Boolean(mode.project.dbPassword);
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
      ? mode.project
      : mode.type === "create" && mode.cloneFrom
        ? mode.cloneFrom
        : null;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: source
      ? {
          // On clone, suffix the source name to make it obvious the new project
          // is a copy and to avoid duplicate-name confusion in the picker.
          name:
            mode.type === "create"
              ? t("nameCopySuffix", { name: source.name })
              : source.name,
          dbServerId: source.dbServerId,
          dbServiceType: source.dbServiceType,
          dbServiceName: source.dbServiceName,
          dbType: source.dbType,
          dbName: source.dbName,
          dbPassword: "",
          dbBackupPath: source.dbBackupPath,
          backendServerId: source.backendServerId,
          backendServiceType: source.backendServiceType,
          backendServiceName: source.backendServiceName,
          backendMockTimeApiUrl: source.backendMockTimeApiUrl ?? "",
          backendMockTimeApiKey: "",
          frontendServerId: source.frontendServerId,
          frontendServiceType: source.frontendServiceType,
          frontendServiceName: source.frontendServiceName,
        }
      : {
          name: "",
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

  async function onSubmit(values: FormValues) {
    const { dbPassword, backendMockTimeApiKey, ...rest } = values;
    const base = {
      ...rest,
      backendMockTimeApiUrl: values.backendMockTimeApiUrl
        ? values.backendMockTimeApiUrl
        : null,
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
        ? await createProject(payload)
        : await updateProject(mode.project.id, payload);

    if (!result.success || !result.data) {
      toast.error(result.message ?? t("submitFailed"));
      return;
    }

    toast.success(
      mode.type === "create" ? t("createdSuccess") : t("savedSuccess")
    );

    if (mode.type === "create") {
      router.push(`/projects/${result.data.id}`);
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
          className="flex flex-col gap-8"
        >
          <Section title={t("info")}>
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
                  <FormControl>
                    <Select {...field}>
                      {SERVICE_TYPES.map((v) => (
                        <option key={v} value={v}>
                          {tEnums(`serviceTypes.${v}`)}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
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
                  <FormControl>
                    <Select {...field}>
                      {DB_TYPES.map((v) => (
                        <option key={v} value={v}>
                          {tEnums(`dbTypes.${v}`)}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
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
                  <FormControl>
                    <Select {...field}>
                      {SERVICE_TYPES.map((v) => (
                        <option key={v} value={v}>
                          {tEnums(`serviceTypes.${v}`)}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
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
                        mode.project.backendMockTimeApiKey
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
                  <FormControl>
                    <Select {...field}>
                      {SERVICE_TYPES.map((v) => (
                        <option key={v} value={v}>
                          {tEnums(`serviceTypes.${v}`)}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
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

function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "border-input bg-transparent dark:bg-input/30 h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        className
      )}
      {...props}
    >
      {children}
    </select>
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
            <FormControl>
              <Select {...field} value={field.value ?? ""} className="flex-1">
                <option value="" disabled>
                  {t("pickServer")}
                </option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.host})
                  </option>
                ))}
              </Select>
            </FormControl>
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
