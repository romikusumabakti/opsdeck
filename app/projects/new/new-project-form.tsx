"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createProject } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const SERVICE_TYPES = ["docker", "system"] as const;
const DB_TYPES = ["postgres", "mssql"] as const;

type FormState = {
  name: string;

  dbServerHost: string;
  dbServerUsername: string;
  dbServerPassword: string;
  dbServiceType: (typeof SERVICE_TYPES)[number];
  dbServiceName: string;
  dbType: (typeof DB_TYPES)[number];
  dbName: string;
  dbIsBackupMounted: boolean;
  dbBackupPath: string;

  backendServerHost: string;
  backendServerUsername: string;
  backendServerPassword: string;
  backendServiceType: (typeof SERVICE_TYPES)[number];
  backendServiceName: string;

  frontendServerHost: string;
  frontendServerUsername: string;
  frontendServerPassword: string;
  frontendServiceType: (typeof SERVICE_TYPES)[number];
  frontendServiceName: string;
};

const initial: FormState = {
  name: "",
  dbServerHost: "",
  dbServerUsername: "",
  dbServerPassword: "",
  dbServiceType: "docker",
  dbServiceName: "",
  dbType: "postgres",
  dbName: "",
  dbIsBackupMounted: false,
  dbBackupPath: "",
  backendServerHost: "",
  backendServerUsername: "",
  backendServerPassword: "",
  backendServiceType: "docker",
  backendServiceName: "",
  frontendServerHost: "",
  frontendServerUsername: "",
  frontendServerPassword: "",
  frontendServiceType: "docker",
  frontendServiceName: "",
};

export function NewProjectForm() {
  const t = useTranslations("newProject");
  const router = useRouter();
  const [form, setForm] = useState<FormState>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const result = await createProject(form);

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
        <ServerFields
          t={t}
          prefix="db"
          host={form.dbServerHost}
          username={form.dbServerUsername}
          password={form.dbServerPassword}
          serviceType={form.dbServiceType}
          serviceName={form.dbServiceName}
          onHost={(v) => setField("dbServerHost", v)}
          onUsername={(v) => setField("dbServerUsername", v)}
          onPassword={(v) => setField("dbServerPassword", v)}
          onServiceType={(v) => setField("dbServiceType", v)}
          onServiceName={(v) => setField("dbServiceName", v)}
        />
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
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.dbIsBackupMounted}
            onChange={(e) => setField("dbIsBackupMounted", e.target.checked)}
          />
          {t("isBackupMounted")}
        </label>
        <Field label={t("backupPath")} htmlFor="dbBackupPath">
          <Input
            id="dbBackupPath"
            required
            value={form.dbBackupPath}
            onChange={(e) => setField("dbBackupPath", e.target.value)}
            placeholder="/var/backups/db"
          />
        </Field>
      </Section>

      <Section title={t("backend")}>
        <ServerFields
          t={t}
          prefix="backend"
          host={form.backendServerHost}
          username={form.backendServerUsername}
          password={form.backendServerPassword}
          serviceType={form.backendServiceType}
          serviceName={form.backendServiceName}
          onHost={(v) => setField("backendServerHost", v)}
          onUsername={(v) => setField("backendServerUsername", v)}
          onPassword={(v) => setField("backendServerPassword", v)}
          onServiceType={(v) => setField("backendServiceType", v)}
          onServiceName={(v) => setField("backendServiceName", v)}
        />
      </Section>

      <Section title={t("frontend")}>
        <ServerFields
          t={t}
          prefix="frontend"
          host={form.frontendServerHost}
          username={form.frontendServerUsername}
          password={form.frontendServerPassword}
          serviceType={form.frontendServiceType}
          serviceName={form.frontendServiceName}
          onHost={(v) => setField("frontendServerHost", v)}
          onUsername={(v) => setField("frontendServerUsername", v)}
          onPassword={(v) => setField("frontendServerPassword", v)}
          onServiceType={(v) => setField("frontendServiceType", v)}
          onServiceName={(v) => setField("frontendServiceName", v)}
        />
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

function ServerFields({
  t,
  prefix,
  host,
  username,
  password,
  serviceType,
  serviceName,
  onHost,
  onUsername,
  onPassword,
  onServiceType,
  onServiceName,
}: {
  t: (key: string) => string;
  prefix: string;
  host: string;
  username: string;
  password: string;
  serviceType: (typeof SERVICE_TYPES)[number];
  serviceName: string;
  onHost: (v: string) => void;
  onUsername: (v: string) => void;
  onPassword: (v: string) => void;
  onServiceType: (v: (typeof SERVICE_TYPES)[number]) => void;
  onServiceName: (v: string) => void;
}) {
  return (
    <>
      <Field label={t("serverHost")} htmlFor={`${prefix}-host`}>
        <Input
          id={`${prefix}-host`}
          required
          value={host}
          onChange={(e) => onHost(e.target.value)}
          placeholder="192.168.x.x"
        />
      </Field>
      <Field label={t("serverUsername")} htmlFor={`${prefix}-username`}>
        <Input
          id={`${prefix}-username`}
          required
          value={username}
          onChange={(e) => onUsername(e.target.value)}
          autoComplete="off"
        />
      </Field>
      <Field label={t("serverPassword")} htmlFor={`${prefix}-password`}>
        <Input
          id={`${prefix}-password`}
          type="password"
          required
          value={password}
          onChange={(e) => onPassword(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <Field label={t("serviceType")} htmlFor={`${prefix}-service-type`}>
        <Select
          id={`${prefix}-service-type`}
          value={serviceType}
          onChange={(e) =>
            onServiceType(e.target.value as (typeof SERVICE_TYPES)[number])
          }
        >
          {SERVICE_TYPES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t("serviceName")}
        htmlFor={`${prefix}-service-name`}
        className="sm:col-span-2"
      >
        <Input
          id={`${prefix}-service-name`}
          required
          value={serviceName}
          onChange={(e) => onServiceName(e.target.value)}
        />
      </Field>
    </>
  );
}
