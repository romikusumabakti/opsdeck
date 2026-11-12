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
import type { SafeS3Connection } from "@/lib/db/schema";
import type { Serialized } from "@/web/api/client";
import {
  createS3Connection,
  testS3ConnectionAction,
  updateS3Connection,
} from "@/web/api/s3-connections";

type Mode =
  | { type: "create" }
  | { type: "edit"; connection: Serialized<SafeS3Connection> };

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "fail"; message: string };

export function S3ConnectionForm({
  mode,
  readOnly = false,
}: {
  mode: Mode;
  // Show the stored values without edit, test or save controls (callers
  // without storage:manage).
  readOnly?: boolean;
}) {
  const t = useTranslations("s3Form");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const initial = mode.type === "edit" ? mode.connection : null;

  const schema = z.object({
    name: z.string().min(1, tCommon("required")),
    endpoint: z.string().url(t("endpointInvalid")),
    region: z.string().min(1, tCommon("required")),
    bucket: z.string().min(1, tCommon("required")),
    accessKeyId: z.string().min(1, tCommon("required")),
    // Secret required on create; on edit, blank means "keep existing".
    secretKey:
      mode.type === "create"
        ? z.string().min(1, tCommon("required"))
        : z.string(),
    forcePathStyle: z.boolean(),
  });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name ?? "",
      endpoint: initial?.endpoint ?? "",
      region: initial?.region ?? "us-east-1",
      bucket: initial?.bucket ?? "",
      accessKeyId: initial?.accessKeyId ?? "",
      secretKey: "",
      forcePathStyle: initial?.forcePathStyle ?? true,
    },
  });

  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const resetTest = () => setTestState({ kind: "idle" });
  const watched = form.watch();

  async function onTest() {
    setTestState({ kind: "testing" });
    const result = await testS3ConnectionAction({
      endpoint: watched.endpoint.trim(),
      region: watched.region.trim(),
      bucket: watched.bucket.trim(),
      accessKeyId: watched.accessKeyId.trim(),
      secretKey: watched.secretKey.length > 0 ? watched.secretKey : undefined,
      forcePathStyle: watched.forcePathStyle,
      connectionId: mode.type === "edit" ? mode.connection.id : undefined,
    });
    setTestState(
      result.ok ? { kind: "ok" } : { kind: "fail", message: result.message }
    );
  }

  async function onSubmit(values: z.infer<typeof schema>) {
    if (mode.type === "create") {
      const result = await createS3Connection({
        name: values.name.trim(),
        endpoint: values.endpoint.trim(),
        region: values.region.trim(),
        bucket: values.bucket.trim(),
        accessKeyId: values.accessKeyId.trim(),
        secretKey: values.secretKey,
        forcePathStyle: values.forcePathStyle,
      });
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message ?? "");
      router.push("/storage");
      return;
    }

    const data: Partial<{
      name: string;
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretKey: string;
      forcePathStyle: boolean;
    }> = {
      name: values.name.trim(),
      endpoint: values.endpoint.trim(),
      region: values.region.trim(),
      bucket: values.bucket.trim(),
      accessKeyId: values.accessKeyId.trim(),
      forcePathStyle: values.forcePathStyle,
    };
    if (values.secretKey.length > 0) data.secretKey = values.secretKey;

    const result = await updateS3Connection(mode.connection.id, data);
    if (!result.success) {
      toast.error(result.message);
      return;
    }
    toast.success(result.message ?? "");
    router.push("/storage");
  }

  const loading = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !loading);

  const canTest =
    watched.endpoint.trim().length > 0 &&
    watched.bucket.trim().length > 0 &&
    watched.accessKeyId.trim().length > 0 &&
    (watched.secretKey.length > 0 || mode.type === "edit") &&
    testState.kind !== "testing" &&
    !loading;

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup>
        {/* Read-only callers (no manage permission) see the stored values with
            every input disabled and no test/save controls. */}
        <fieldset disabled={readOnly} className="contents">
          <Controller
            name="name"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="s3-connection-name">
                  {t("name")}
                </FieldLabel>
                <Input
                  placeholder={t("namePlaceholder")}
                  {...field}
                  id="s3-connection-name"
                  aria-invalid={fieldState.invalid}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <Controller
            name="endpoint"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="s3-connection-endpoint">
                  {t("endpoint")}
                </FieldLabel>
                <Input
                  placeholder="https://s3.example.com"
                  {...field}
                  id="s3-connection-endpoint"
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Controller
              name="bucket"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="s3-connection-bucket">
                    {t("bucket")}
                  </FieldLabel>
                  <Input
                    {...field}
                    id="s3-connection-bucket"
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
              name="region"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="s3-connection-region">
                    {t("region")}
                  </FieldLabel>
                  <Input
                    {...field}
                    id="s3-connection-region"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </div>
          <Controller
            name="accessKeyId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="s3-connection-access-key-id">
                  {t("accessKeyId")}
                </FieldLabel>
                <Input
                  autoComplete="off"
                  {...field}
                  id="s3-connection-access-key-id"
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
            name="secretKey"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="s3-connection-secret-key">
                  {mode.type === "edit" ? t("secretKeyEdit") : t("secretKey")}
                </FieldLabel>
                <PasswordInput
                  autoComplete="new-password"
                  placeholder={
                    mode.type === "edit"
                      ? t("secretKeyEditPlaceholder")
                      : undefined
                  }
                  {...field}
                  id="s3-connection-secret-key"
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
            render={({ field, fieldState }) => (
              <Field
                orientation="horizontal"
                data-invalid={fieldState.invalid}
                className="items-center justify-between gap-4"
              >
                <FieldContent>
                  <FieldLabel htmlFor="s3-connection-force-path-style">
                    {t("forcePathStyle")}
                  </FieldLabel>
                  <FieldDescription>
                    {t("forcePathStyleDescription")}
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="s3-connection-force-path-style"
                  aria-invalid={fieldState.invalid}
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
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onTest}
              disabled={!canTest}
            >
              {testState.kind === "testing" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {t("testConnection")}
            </Button>
            <TestStatus state={testState} t={t} />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push("/storage")}
            disabled={loading}
          >
            {tCommon("cancel")}
          </Button>
          {readOnly ? null : (
            <Button type="submit" disabled={loading}>
              {loading
                ? t("submitting")
                : mode.type === "edit"
                  ? t("saveChanges")
                  : t("create")}
            </Button>
          )}
        </div>
      </FieldGroup>
    </form>
  );
}

function TestStatus({
  state,
  t,
}: {
  state: TestState;
  t: (key: string) => string;
}) {
  if (state.kind === "idle" || state.kind === "testing") return null;
  if (state.kind === "ok") {
    return (
      <span className="text-sm text-success inline-flex items-center gap-1">
        <CheckCircle2 className="size-4" />
        {t("testSuccess")}
      </span>
    );
  }
  return (
    <span className="text-sm text-destructive inline-flex items-center gap-1 break-all">
      <XCircle className="size-4 shrink-0" />
      <span>
        {t("testFailed")}: {state.message}
      </span>
    </span>
  );
}
