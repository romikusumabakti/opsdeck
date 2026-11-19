import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Button } from "@/components/ui/button";
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
import { useRouter } from "@/i18n/navigation";
import { normalizeKeyPrefix } from "@/lib/validation";
import { ApiError } from "@/web/api/client";
import {
  createEnvironmentStorage,
  type EnvironmentStorageRow,
  testEnvironmentStorage,
  updateEnvironmentStorage,
} from "@/web/api/environment-storage";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "fail"; message: string };

const SECRET_REQUIRED = "s3SecretRequiredForLocationChange";

/**
 * Add or edit one of an environment's storage connections. The secret is
 * never sent back: on edit a blank one keeps the stored secret, unless the
 * endpoint, region, bucket, key prefix, access key or path style changed
 * (the server asks for it again, and the form says so before saving).
 */
export function StorageForm({
  environmentId,
  basePath,
  connection,
  readOnly = false,
}: {
  environmentId: string;
  /** `/KEY/slug/storage`, where Cancel and a save return to. */
  basePath: string;
  connection?: EnvironmentStorageRow;
  /** Show the stored values without edit, test or save controls. */
  readOnly?: boolean;
}) {
  const t = useTranslations("s3Form");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("actionErrors");
  const router = useRouter();
  const editing = connection !== undefined;

  const schema = z.object({
    name: z.string().trim().min(1, tCommon("required")),
    endpoint: z.string().trim().url(t("endpointInvalid")),
    region: z.string().trim().min(1, tCommon("required")),
    bucket: z.string().trim().min(1, tCommon("required")),
    keyPrefix: z
      .string()
      .refine((v) => normalizeKeyPrefix(v).ok, tErrors("s3KeyPrefixInvalid")),
    accessKeyId: z.string().trim().min(1, tCommon("required")),
    secretKey: editing ? z.string() : z.string().min(1, tCommon("required")),
    forcePathStyle: z.boolean(),
  });
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: connection?.name ?? "",
      endpoint: connection?.endpoint ?? "",
      region: connection?.region ?? "us-east-1",
      bucket: connection?.bucket ?? "",
      keyPrefix: connection?.keyPrefix ?? "",
      accessKeyId: connection?.accessKeyId ?? "",
      secretKey: "",
      forcePathStyle: connection?.forcePathStyle ?? true,
    },
  });
  const watched = form.watch();
  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const resetTest = () => setTestState({ kind: "idle" });
  const loading = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !loading);

  // Whether the typed values point the stored secret somewhere new (the
  // server's changesS3Location rule): then the secret must be typed again.
  const typedPrefix = normalizeKeyPrefix(watched.keyPrefix);
  const locationChanged =
    connection !== undefined &&
    (watched.endpoint.trim() !== connection.endpoint ||
      watched.region.trim() !== connection.region ||
      watched.bucket.trim() !== connection.bucket ||
      watched.accessKeyId.trim() !== connection.accessKeyId ||
      watched.forcePathStyle !== connection.forcePathStyle ||
      (typedPrefix.ok && typedPrefix.prefix !== connection.keyPrefix));
  const secretMissing =
    editing && locationChanged && watched.secretKey.length === 0;

  const probe = (values: Values) => ({
    endpoint: values.endpoint.trim(),
    region: values.region.trim(),
    bucket: values.bucket.trim(),
    accessKeyId: values.accessKeyId.trim(),
    ...(values.secretKey ? { secretKey: values.secretKey } : {}),
    forcePathStyle: values.forcePathStyle,
    keyPrefix: values.keyPrefix.trim() || null,
  });

  // A refusal with a code lands on its field; any other shows as a toast.
  function report(error: unknown) {
    if (error instanceof ApiError && error.code === SECRET_REQUIRED) {
      form.setError("secretKey", { message: error.message });
      return;
    }
    if (error instanceof ApiError && error.code === "s3KeyPrefixInvalid") {
      form.setError("keyPrefix", { message: error.message });
      return;
    }
    if (error instanceof ApiError && error.status !== 401) {
      toast.error(error.message);
      return;
    }
    throw error;
  }

  async function onTest() {
    const valid = await form.trigger([
      "endpoint",
      "region",
      "bucket",
      "accessKeyId",
      "keyPrefix",
    ]);
    if (!valid || secretMissing) {
      if (secretMissing) {
        form.setError("secretKey", { message: tErrors(SECRET_REQUIRED) });
      }
      return;
    }
    setTestState({ kind: "testing" });
    try {
      const result = await testEnvironmentStorage(environmentId, {
        ...probe(form.getValues()),
        connectionId: connection?.id,
      });
      setTestState(
        result.ok ? { kind: "ok" } : { kind: "fail", message: result.message }
      );
    } catch (error) {
      setTestState({ kind: "idle" });
      report(error);
    }
  }

  async function onSubmit(values: Values) {
    if (secretMissing) {
      form.setError("secretKey", { message: tErrors(SECRET_REQUIRED) });
      return;
    }
    try {
      if (connection) {
        await updateEnvironmentStorage(environmentId, connection.id, {
          ...probe(values),
          name: values.name.trim(),
        });
        toast.success(tErrors("s3Updated"));
      } else {
        await createEnvironmentStorage(environmentId, {
          ...probe(values),
          secretKey: values.secretKey,
          name: values.name.trim(),
        });
        toast.success(tErrors("s3Created"));
      }
    } catch (error) {
      report(error);
      return;
    }
    form.reset(values);
    router.push(basePath);
  }

  const text = (
    name:
      | "name"
      | "endpoint"
      | "bucket"
      | "region"
      | "keyPrefix"
      | "accessKeyId",
    label: string,
    options: {
      placeholder?: string;
      description?: string;
      probed?: boolean;
    } = {}
  ) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={`storage-${name}`}>{label}</FieldLabel>
          <Input
            autoComplete="off"
            placeholder={options.placeholder}
            {...field}
            id={`storage-${name}`}
            aria-invalid={fieldState.invalid}
            onChange={(e) => {
              if (options.probed) resetTest();
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
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup>
        <fieldset disabled={readOnly} className="contents">
          {text("name", t("name"), { placeholder: t("namePlaceholder") })}
          {text("endpoint", t("endpoint"), {
            placeholder: "https://s3.example.com",
            probed: true,
          })}
          <div className="grid gap-4 sm:grid-cols-2">
            {text("bucket", t("bucket"), { probed: true })}
            {text("region", t("region"), { probed: true })}
          </div>
          {text("keyPrefix", t("keyPrefix"), {
            placeholder: "team-a/",
            description: t("keyPrefixDescription"),
            probed: true,
          })}
          {text("accessKeyId", t("accessKeyId"), { probed: true })}
          <Controller
            name="secretKey"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="storage-secretKey">
                  {t("secretKey")}
                </FieldLabel>
                <PasswordInput
                  autoComplete="new-password"
                  placeholder={
                    editing ? t("secretKeyEditPlaceholder") : undefined
                  }
                  {...field}
                  id="storage-secretKey"
                  aria-invalid={fieldState.invalid}
                  onChange={(e) => {
                    resetTest();
                    field.onChange(e);
                  }}
                />
                {editing && !readOnly && (
                  <FieldDescription>
                    {locationChanged
                      ? t("secretKeyRequiredHint")
                      : t("secretKeyKeepHint")}
                  </FieldDescription>
                )}
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
                  <FieldLabel htmlFor="storage-forcePathStyle">
                    {t("forcePathStyle")}
                  </FieldLabel>
                  <FieldDescription>
                    {t("forcePathStyleDescription")}
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="storage-forcePathStyle"
                  checked={field.value}
                  onCheckedChange={(v) => {
                    resetTest();
                    field.onChange(v);
                  }}
                />
              </Field>
            )}
          />
        </fieldset>

        {readOnly ? null : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onTest()}
              disabled={testState.kind === "testing" || loading}
            >
              {testState.kind === "testing" && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              {t("testConnection")}
            </Button>
            <TestStatus state={testState} />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push(basePath)}
            disabled={loading}
          >
            {tCommon("cancel")}
          </Button>
          {readOnly ? null : (
            <Button type="submit" disabled={loading}>
              {loading
                ? t("submitting")
                : editing
                  ? t("saveChanges")
                  : t("create")}
            </Button>
          )}
        </div>
      </FieldGroup>
    </form>
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
