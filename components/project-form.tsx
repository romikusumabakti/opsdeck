"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { createProject, updateProject } from "@/actions/projects";
import { ServerCreateDialog } from "@/components/server-create-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";
import type { Project, Server } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

const SERVICE_TYPES = ["docker", "system"] as const;
const DB_TYPES = ["postgres", "mssql"] as const;

type ServerRole = "db" | "backend" | "frontend";

type FormState = {
  name: string;

  dbServerId: string | null;
  dbServiceType: (typeof SERVICE_TYPES)[number];
  dbServiceName: string;
  dbType: (typeof DB_TYPES)[number];
  dbName: string;
  dbIsBackupMounted: boolean;
  dbBackupPath: string;

  backendServerId: string | null;
  backendServiceType: (typeof SERVICE_TYPES)[number];
  backendServiceName: string;

  frontendServerId: string | null;
  frontendServiceType: (typeof SERVICE_TYPES)[number];
  frontendServiceName: string;
};

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

  const [form, setForm] = useState<FormState>(() => {
    if (mode.type === "edit") {
      const p = mode.project;
      return {
        name: p.name,
        dbServerId: p.dbServerId,
        dbServiceType: p.dbServiceType,
        dbServiceName: p.dbServiceName,
        dbType: p.dbType,
        dbName: p.dbName,
        dbIsBackupMounted: p.dbIsBackupMounted,
        dbBackupPath: p.dbBackupPath,
        backendServerId: p.backendServerId,
        backendServiceType: p.backendServiceType,
        backendServiceName: p.backendServiceName,
        frontendServerId: p.frontendServerId,
        frontendServiceType: p.frontendServiceType,
        frontendServiceName: p.frontendServiceName,
      };
    }
    return {
      name: "",
      dbServerId: initialServers[0]?.id ?? null,
      dbServiceType: "docker",
      dbServiceName: "",
      dbType: "postgres",
      dbName: "",
      dbIsBackupMounted: false,
      dbBackupPath: "",
      backendServerId: initialServers[0]?.id ?? null,
      backendServiceType: "docker",
      backendServiceName: "",
      frontendServerId: initialServers[0]?.id ?? null,
      frontendServiceType: "docker",
      frontendServiceName: "",
    };
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function onServerCreated(server: Server) {
    setServers((prev) => [...prev, server]);
    if (dialogRole === "db") setField("dbServerId", server.id);
    if (dialogRole === "backend") setField("backendServerId", server.id);
    if (dialogRole === "frontend") setField("frontendServerId", server.id);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (
      form.dbServerId == null ||
      form.backendServerId == null ||
      form.frontendServerId == null
    ) {
      setError(t("pickServerRequired"));
      return;
    }

    setLoading(true);
    const payload = {
      name: form.name,
      dbServerId: form.dbServerId,
      dbServiceType: form.dbServiceType,
      dbServiceName: form.dbServiceName,
      dbType: form.dbType,
      dbName: form.dbName,
      dbIsBackupMounted: form.dbIsBackupMounted,
      dbBackupPath: form.dbBackupPath,
      backendServerId: form.backendServerId,
      backendServiceType: form.backendServiceType,
      backendServiceName: form.backendServiceName,
      frontendServerId: form.frontendServerId,
      frontendServiceType: form.frontendServiceType,
      frontendServiceName: form.frontendServiceName,
    };

    const result =
      mode.type === "create"
        ? await createProject(payload)
        : await updateProject(mode.project.id, payload);

    setLoading(false);

    if (!result.success || !result.data) {
      setError(result.message ?? t("submitFailed"));
      return;
    }

    if (mode.type === "create") {
      router.push(`/projects/${result.data.id}`);
    }
    router.refresh();
  }

  return (
    <>
      <form onSubmit={onSubmit} className="flex flex-col gap-8">
        <Section title={t("info")}>
          <Field label={t("name")} htmlFor="name">
            <Input
              id="name"
              required
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder={t("namePlaceholder")}
            />
          </Field>
        </Section>

        <Section title={t("database")}>
          <ServerPicker
            t={t}
            prefix="db"
            servers={servers}
            value={form.dbServerId}
            onChange={(id) => setField("dbServerId", id)}
            onRequestCreate={() => setDialogRole("db")}
          />
          <Field label={t("serviceType")} htmlFor="db-service-type">
            <Select
              id="db-service-type"
              value={form.dbServiceType}
              onChange={(e) =>
                setField(
                  "dbServiceType",
                  e.target.value as FormState["dbServiceType"]
                )
              }
            >
              {SERVICE_TYPES.map((v) => (
                <option key={v} value={v}>
                  {tEnums(`serviceTypes.${v}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("serviceName")} htmlFor="db-service-name">
            <Input
              id="db-service-name"
              required
              value={form.dbServiceName}
              onChange={(e) => setField("dbServiceName", e.target.value)}
            />
          </Field>
          <Field label={t("dbType")} htmlFor="dbType">
            <Select
              id="dbType"
              value={form.dbType}
              onChange={(e) =>
                setField("dbType", e.target.value as FormState["dbType"])
              }
            >
              {DB_TYPES.map((v) => (
                <option key={v} value={v}>
                  {tEnums(`dbTypes.${v}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("dbName")} htmlFor="dbName">
            <Input
              id="dbName"
              required
              value={form.dbName}
              onChange={(e) => setField("dbName", e.target.value)}
            />
          </Field>
          <Field label={t("backupPath")} htmlFor="dbBackupPath">
            <Input
              id="dbBackupPath"
              required
              value={form.dbBackupPath}
              onChange={(e) => setField("dbBackupPath", e.target.value)}
              placeholder="/var/backups/db"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={form.dbIsBackupMounted}
              onChange={(e) => setField("dbIsBackupMounted", e.target.checked)}
            />
            {t("isBackupMounted")}
          </label>
        </Section>

        <Section title={t("backend")}>
          <ServerPicker
            t={t}
            prefix="backend"
            servers={servers}
            value={form.backendServerId}
            onChange={(id) => setField("backendServerId", id)}
            onRequestCreate={() => setDialogRole("backend")}
          />
          <Field label={t("serviceType")} htmlFor="backend-service-type">
            <Select
              id="backend-service-type"
              value={form.backendServiceType}
              onChange={(e) =>
                setField(
                  "backendServiceType",
                  e.target.value as FormState["backendServiceType"]
                )
              }
            >
              {SERVICE_TYPES.map((v) => (
                <option key={v} value={v}>
                  {tEnums(`serviceTypes.${v}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("serviceName")} htmlFor="backend-service-name">
            <Input
              id="backend-service-name"
              required
              value={form.backendServiceName}
              onChange={(e) => setField("backendServiceName", e.target.value)}
            />
          </Field>
        </Section>

        <Section title={t("frontend")}>
          <ServerPicker
            t={t}
            prefix="frontend"
            servers={servers}
            value={form.frontendServerId}
            onChange={(id) => setField("frontendServerId", id)}
            onRequestCreate={() => setDialogRole("frontend")}
          />
          <Field label={t("serviceType")} htmlFor="frontend-service-type">
            <Select
              id="frontend-service-type"
              value={form.frontendServiceType}
              onChange={(e) =>
                setField(
                  "frontendServiceType",
                  e.target.value as FormState["frontendServiceType"]
                )
              }
            >
              {SERVICE_TYPES.map((v) => (
                <option key={v} value={v}>
                  {tEnums(`serviceTypes.${v}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("serviceName")} htmlFor="frontend-service-name">
            <Input
              id="frontend-service-name"
              required
              value={form.frontendServiceName}
              onChange={(e) => setField("frontendServiceName", e.target.value)}
            />
          </Field>
        </Section>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

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

function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
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
  prefix,
  servers,
  value,
  onChange,
  onRequestCreate,
}: {
  t: (key: string) => string;
  prefix: string;
  servers: Server[];
  value: string | null;
  onChange: (id: string | null) => void;
  onRequestCreate: () => void;
}) {
  const selectId = `${prefix}-server`;

  return (
    <Field label={t("server")} htmlFor={selectId} className="sm:col-span-2">
      <div className="flex gap-2">
        <Select
          id={selectId}
          required
          value={value ?? ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : e.target.value)
          }
          className="flex-1"
        >
          <option value="" disabled>
            {t("pickServer")}
          </option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.host})
            </option>
          ))}
        </Select>
        <Button type="button" variant="outline" onClick={onRequestCreate}>
          <Plus className="size-4" />
          <span className="hidden sm:inline">{t("newServerShort")}</span>
        </Button>
      </div>
    </Field>
  );
}
