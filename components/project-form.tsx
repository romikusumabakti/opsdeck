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
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";
import type { Project, Server } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

const SERVICE_TYPES = ["docker", "system"] as const;
const DB_TYPES = ["postgres", "mssql"] as const;

type ServerRole = "db" | "backend" | "frontend";

type Mode = { type: "create" } | { type: "edit"; project: Project };

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

  const schema = z.object({
    name: z.string().min(1, tCommon("required")),

    dbServerId: z.string().min(1, t("pickServerRequired")),
    dbServiceType: z.enum(SERVICE_TYPES),
    dbServiceName: z.string().min(1, tCommon("required")),
    dbType: z.enum(DB_TYPES),
    dbName: z.string().min(1, tCommon("required")),
    dbIsBackupMounted: z.boolean(),
    dbBackupPath: z.string().min(1, tCommon("required")),

    backendServerId: z.string().min(1, t("pickServerRequired")),
    backendServiceType: z.enum(SERVICE_TYPES),
    backendServiceName: z.string().min(1, tCommon("required")),
    backendSimulateTimeApiUrl: z.union([
      z.string().trim().url(tCommon("urlInvalid")),
      z.literal(""),
    ]),

    frontendServerId: z.string().min(1, t("pickServerRequired")),
    frontendServiceType: z.enum(SERVICE_TYPES),
    frontendServiceName: z.string().min(1, tCommon("required")),
  });

  type FormValues = z.infer<typeof schema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues:
      mode.type === "edit"
        ? {
            name: mode.project.name,
            dbServerId: mode.project.dbServerId,
            dbServiceType: mode.project.dbServiceType,
            dbServiceName: mode.project.dbServiceName,
            dbType: mode.project.dbType,
            dbName: mode.project.dbName,
            dbIsBackupMounted: mode.project.dbIsBackupMounted,
            dbBackupPath: mode.project.dbBackupPath,
            backendServerId: mode.project.backendServerId,
            backendServiceType: mode.project.backendServiceType,
            backendServiceName: mode.project.backendServiceName,
            backendSimulateTimeApiUrl:
              mode.project.backendSimulateTimeApiUrl ?? "",
            frontendServerId: mode.project.frontendServerId,
            frontendServiceType: mode.project.frontendServiceType,
            frontendServiceName: mode.project.frontendServiceName,
          }
        : {
            name: "",
            dbServerId: initialServers[0]?.id ?? "",
            dbServiceType: "docker",
            dbServiceName: "",
            dbType: "postgres",
            dbName: "",
            dbIsBackupMounted: false,
            dbBackupPath: "",
            backendServerId: initialServers[0]?.id ?? "",
            backendServiceType: "docker",
            backendServiceName: "",
            backendSimulateTimeApiUrl: "",
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
    const payload = {
      ...values,
      backendSimulateTimeApiUrl: values.backendSimulateTimeApiUrl
        ? values.backendSimulateTimeApiUrl
        : null,
    };
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
              name="dbBackupPath"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("backupPath")}</FormLabel>
                  <FormControl>
                    <Input placeholder="/var/backups/db" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="dbIsBackupMounted"
              render={({ field }) => (
                <FormItem className="grid-flow-col items-center justify-start gap-2 sm:col-span-2">
                  <FormControl>
                    <input
                      id="db-backup-mounted"
                      type="checkbox"
                      checked={field.value}
                      onChange={(e) => field.onChange(e.target.checked)}
                      className="size-4"
                    />
                  </FormControl>
                  <Label
                    htmlFor="db-backup-mounted"
                    className="text-sm font-normal"
                  >
                    {t("isBackupMounted")}
                  </Label>
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
              name="backendSimulateTimeApiUrl"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>{t("simulateTimeApiUrl")}</FormLabel>
                  <FormControl>
                    <Input
                      type="url"
                      placeholder="https://api.example.com/system-time"
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    {t("simulateTimeApiUrlHint")}
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
