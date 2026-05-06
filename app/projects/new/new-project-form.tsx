"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createProject } from "@/actions/projects";
import { createServer } from "@/actions/servers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Server } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

const SERVICE_TYPES = ["docker", "system"] as const;
const DB_TYPES = ["postgres", "mssql"] as const;

const NEW_SERVER_VALUE = "__new__";

type ServerSelection =
  | { mode: "existing"; id: number }
  | { mode: "new"; name: string; host: string; username: string; password: string };

type FormState = {
  name: string;

  dbServer: ServerSelection;
  dbServiceType: (typeof SERVICE_TYPES)[number];
  dbServiceName: string;
  dbType: (typeof DB_TYPES)[number];
  dbName: string;
  dbIsBackupMounted: boolean;
  dbBackupPath: string;

  backendServer: ServerSelection;
  backendServiceType: (typeof SERVICE_TYPES)[number];
  backendServiceName: string;

  frontendServer: ServerSelection;
  frontendServiceType: (typeof SERVICE_TYPES)[number];
  frontendServiceName: string;
};

const emptyNewServer: ServerSelection = {
  mode: "new",
  name: "",
  host: "",
  username: "",
  password: "",
};

function initialServerSelection(servers: Server[]): ServerSelection {
  return servers.length > 0
    ? { mode: "existing", id: servers[0].id }
    : { ...emptyNewServer };
}

export function NewProjectForm({ servers }: { servers: Server[] }) {
  const t = useTranslations("newProject");
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => ({
    name: "",
    dbServer: initialServerSelection(servers),
    dbServiceType: "docker",
    dbServiceName: "",
    dbType: "postgres",
    dbName: "",
    dbIsBackupMounted: false,
    dbBackupPath: "",
    backendServer: initialServerSelection(servers),
    backendServiceType: "docker",
    backendServiceName: "",
    frontendServer: initialServerSelection(servers),
    frontendServiceType: "docker",
    frontendServiceName: "",
  }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function resolveServerId(
    selection: ServerSelection
  ): Promise<number | null> {
    if (selection.mode === "existing") return selection.id;

    const result = await createServer({
      name: selection.name.trim(),
      host: selection.host.trim(),
      username: selection.username.trim(),
      password: selection.password,
    });
    if (!result.success) {
      setError(result.message);
      return null;
    }
    return result.data.id;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const dbServerId = await resolveServerId(form.dbServer);
    if (dbServerId == null) return setLoading(false);
    const backendServerId = await resolveServerId(form.backendServer);
    if (backendServerId == null) return setLoading(false);
    const frontendServerId = await resolveServerId(form.frontendServer);
    if (frontendServerId == null) return setLoading(false);

    const result = await createProject({
      name: form.name,
      dbServerId,
      dbServiceType: form.dbServiceType,
      dbServiceName: form.dbServiceName,
      dbType: form.dbType,
      dbName: form.dbName,
      dbIsBackupMounted: form.dbIsBackupMounted,
      dbBackupPath: form.dbBackupPath,
      backendServerId,
      backendServiceType: form.backendServiceType,
      backendServiceName: form.backendServiceName,
      frontendServerId,
      frontendServiceType: form.frontendServiceType,
      frontendServiceName: form.frontendServiceName,
    });

    setLoading(false);

    if (!result.success || !result.data) {
      setError(result.message ?? t("submitFailed"));
      return;
    }

    router.push(`/projects/${result.data.id}`);
    router.refresh();
  }

  return (
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
          value={form.dbServer}
          onChange={(v) => setField("dbServer", v)}
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
                {v}
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
                {v}
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
          value={form.backendServer}
          onChange={(v) => setField("backendServer", v)}
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
                {v}
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
          value={form.frontendServer}
          onChange={(v) => setField("frontendServer", v)}
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
                {v}
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
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={loading}>
          {loading ? t("submitting") : t("submit")}
        </Button>
      </div>
    </form>
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
}: {
  t: (key: string) => string;
  prefix: string;
  servers: Server[];
  value: ServerSelection;
  onChange: (v: ServerSelection) => void;
}) {
  const selectId = `${prefix}-server`;
  const dropdownValue =
    value.mode === "existing" ? String(value.id) : NEW_SERVER_VALUE;

  function onDropdownChange(next: string) {
    if (next === NEW_SERVER_VALUE) {
      onChange({ ...emptyNewServer });
      return;
    }
    onChange({ mode: "existing", id: Number(next) });
  }

  return (
    <>
      <Field
        label={t("server")}
        htmlFor={selectId}
        className="sm:col-span-2"
      >
        <Select
          id={selectId}
          value={dropdownValue}
          onChange={(e) => onDropdownChange(e.target.value)}
        >
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.host})
            </option>
          ))}
          <option value={NEW_SERVER_VALUE}>
            {servers.length > 0 ? t("createNewServer") : t("noServer")}
          </option>
        </Select>
      </Field>
      {value.mode === "new" && (
        <>
          <Field
            label={t("serverName")}
            htmlFor={`${prefix}-server-name`}
            className="sm:col-span-2"
          >
            <Input
              id={`${prefix}-server-name`}
              required
              value={value.name}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              placeholder={t("serverNamePlaceholder")}
            />
          </Field>
          <Field
            label={t("serverHost")}
            htmlFor={`${prefix}-server-host`}
          >
            <Input
              id={`${prefix}-server-host`}
              required
              value={value.host}
              onChange={(e) => onChange({ ...value, host: e.target.value })}
              placeholder="192.168.x.x"
            />
          </Field>
          <Field
            label={t("serverUsername")}
            htmlFor={`${prefix}-server-username`}
          >
            <Input
              id={`${prefix}-server-username`}
              required
              value={value.username}
              onChange={(e) =>
                onChange({ ...value, username: e.target.value })
              }
              autoComplete="off"
            />
          </Field>
          <Field
            label={t("serverPassword")}
            htmlFor={`${prefix}-server-password`}
            className="sm:col-span-2"
          >
            <Input
              id={`${prefix}-server-password`}
              type="password"
              required
              value={value.password}
              onChange={(e) =>
                onChange({ ...value, password: e.target.value })
              }
              autoComplete="new-password"
            />
          </Field>
        </>
      )}
    </>
  );
}
