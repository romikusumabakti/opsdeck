import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { normalizeKeyPrefix } from "@/lib/validation";
import {
  clearBackupDestination,
  type InstanceBackupsData,
  saveBackupDestination,
  testBackupDestination,
} from "@/web/api/instance";
import { refreshInstance, reportError } from "./report-error";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "fail"; message: string };

/**
 * Admin › Instance › Backups: the S3 bucket backups and the archives of
 * deleted environments go to, with its own keys. The stored secret is never
 * sent back: a blank secret keeps it, and the server asks for it again when
 * the endpoint, region, bucket, key prefix, access key or path style change.
 */
export function BackupDestinationCard({
  destination,
}: {
  destination: InstanceBackupsData["destination"];
}) {
  const t = useTranslations("instanceBackups.destinationCard");
  const tForm = useTranslations("s3Form");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("actionErrors");
  const dialog = useDialog();
  const queryClient = useQueryClient();

  const schema = z.object({
    endpoint: z.string().trim().url(tForm("endpointInvalid")),
    region: z.string().trim().min(1, tCommon("required")),
    bucket: z.string().trim().min(1, tCommon("required")),
    accessKeyId: z.string().trim().min(1, tCommon("required")),
    // Required for a new destination; blank keeps the stored one.
    secretKey: destination
      ? z.string()
      : z.string().min(1, tCommon("required")),
    keyPrefix: z
      .string()
      .refine((v) => normalizeKeyPrefix(v).ok, tErrors("s3KeyPrefixInvalid")),
    forcePathStyle: z.boolean(),
  });
  type Values = z.infer<typeof schema>;

  const defaults = (d: typeof destination): Values => ({
    endpoint: d?.endpoint ?? "",
    region: d?.region ?? "auto",
    bucket: d?.bucket ?? "",
    accessKeyId: d?.accessKeyId ?? "",
    secretKey: "",
    keyPrefix: d?.keyPrefix ?? "",
    forcePathStyle: d?.forcePathStyle ?? true,
  });
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: defaults(destination),
  });
  const loading = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !loading);
  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const [removing, setRemoving] = useState(false);
  const resetTest = () => setTestState({ kind: "idle" });

  const body = (values: Values) => ({
    endpoint: values.endpoint.trim(),
    region: values.region.trim(),
    bucket: values.bucket.trim(),
    accessKeyId: values.accessKeyId.trim(),
    ...(values.secretKey ? { secretKey: values.secretKey } : {}),
    keyPrefix: values.keyPrefix.trim() || null,
    forcePathStyle: values.forcePathStyle,
  });

  async function onTest() {
    const valid = await form.trigger([
      "endpoint",
      "region",
      "bucket",
      "accessKeyId",
      "keyPrefix",
    ]);
    if (!valid) return;
    setTestState({ kind: "testing" });
    try {
      const result = await testBackupDestination(body(form.getValues()));
      setTestState(
        result.ok ? { kind: "ok" } : { kind: "fail", message: result.message }
      );
    } catch (error) {
      setTestState({ kind: "idle" });
      reportError(error);
    }
  }

  async function onSubmit(values: Values) {
    try {
      const saved = await saveBackupDestination(body(values));
      form.reset(defaults(saved));
    } catch (error) {
      reportError(error);
      return;
    }
    toast.success(t("saved"));
    await refreshInstance(queryClient);
  }

  async function onRemove() {
    const ok = await dialog.confirm({
      title: t("removeTitle"),
      description: t("removeDescription"),
      confirmText: t("remove"),
      destructive: true,
    });
    if (!ok) return;
    setRemoving(true);
    try {
      await clearBackupDestination();
      form.reset(defaults(null));
      toast.success(t("removed"));
      await refreshInstance(queryClient);
    } catch (error) {
      reportError(error);
    } finally {
      setRemoving(false);
    }
  }

  const text = (
    name: "endpoint" | "bucket" | "region" | "accessKeyId" | "keyPrefix",
    label: string,
    options: { placeholder?: string; description?: string } = {}
  ) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={`backup-destination-${name}`}>
            {label}
          </FieldLabel>
          <Input
            autoComplete="off"
            placeholder={options.placeholder}
            {...field}
            id={`backup-destination-${name}`}
            aria-invalid={fieldState.invalid}
            onChange={(e) => {
              resetTest();
              field.onChange(e);
            }}
          />
          {options.description && (
            <FieldDescription>{options.description}</FieldDescription>
          )}
          <FieldError errors={[fieldState.error]} />
        </Field>
      )}
    />
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex max-w-2xl flex-col gap-4"
        >
          <FieldGroup>
            {text("endpoint", tForm("endpoint"), {
              placeholder: "https://s3.example.com",
            })}
            <div className="grid gap-4 sm:grid-cols-2">
              {text("bucket", tForm("bucket"))}
              {text("region", tForm("region"))}
            </div>
            {text("keyPrefix", t("keyPrefix"), {
              placeholder: "panel/",
              description: t("keyPrefixDescription"),
            })}
            {text("accessKeyId", tForm("accessKeyId"))}
            <Controller
              name="secretKey"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="backup-destination-secretKey">
                    {tForm("secretKey")}
                  </FieldLabel>
                  <PasswordInput
                    autoComplete="new-password"
                    placeholder={
                      destination ? t("secretKeyPlaceholderSet") : undefined
                    }
                    {...field}
                    id="backup-destination-secretKey"
                    aria-invalid={fieldState.invalid}
                    onChange={(e) => {
                      resetTest();
                      field.onChange(e);
                    }}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              name="forcePathStyle"
              control={form.control}
              render={({ field }) => (
                <Field
                  orientation="horizontal"
                  className="items-center justify-between gap-4"
                >
                  <FieldContent>
                    <FieldLabel htmlFor="backup-destination-forcePathStyle">
                      {tForm("forcePathStyle")}
                    </FieldLabel>
                    <FieldDescription>
                      {tForm("forcePathStyleDescription")}
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="backup-destination-forcePathStyle"
                    checked={field.value}
                    onCheckedChange={(v) => {
                      resetTest();
                      field.onChange(v);
                    }}
                  />
                </Field>
              )}
            />
          </FieldGroup>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => void onTest()}
              disabled={testState.kind === "testing" || loading}
            >
              {testState.kind === "testing" && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              {tForm("testConnection")}
            </Button>
            <TestStatus state={testState} />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {destination && (
              <Button
                type="button"
                variant="destructive"
                className="me-auto"
                onClick={() => void onRemove()}
                disabled={removing || loading}
              >
                {removing ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Trash2 data-icon="inline-start" />
                )}
                {t("remove")}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                form.reset();
                resetTest();
              }}
              disabled={loading || !form.formState.isDirty}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              {tCommon("save")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function TestStatus({ state }: { state: TestState }) {
  const t = useTranslations("s3Form");
  if (state.kind === "idle" || state.kind === "testing") return null;
  if (state.kind === "ok") {
    return (
      <span
        aria-live="polite"
        className="inline-flex items-center gap-1 text-sm text-success"
      >
        <CheckCircle2 className="size-4" />
        {t("testSuccess")}
      </span>
    );
  }
  return (
    <span
      aria-live="polite"
      className="inline-flex items-center gap-1 break-all text-sm text-destructive"
    >
      <XCircle className="size-4 shrink-0" />
      <span>
        {t("testFailed")}: {state.message}
      </span>
    </span>
  );
}
