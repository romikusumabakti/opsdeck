"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  createS3Connection,
  testS3ConnectionAction,
  updateS3Connection,
} from "@/actions/s3-connections";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";
import type { SafeS3Connection } from "@/lib/db/schema";

type Mode = { type: "create" } | { type: "edit"; connection: SafeS3Connection };

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "fail"; message: string };

export function S3ConnectionForm({ mode }: { mode: Mode }) {
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
      router.refresh();
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
    router.refresh();
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
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-4"
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
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
          name="endpoint"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("endpoint")}</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://s3.example.com"
                  {...field}
                  onChange={(e) => {
                    resetTest();
                    field.onChange(e);
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="bucket"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("bucket")}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    onChange={(e) => {
                      resetTest();
                      field.onChange(e);
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="region"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("region")}</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="accessKeyId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("accessKeyId")}</FormLabel>
              <FormControl>
                <Input
                  autoComplete="off"
                  {...field}
                  onChange={(e) => {
                    resetTest();
                    field.onChange(e);
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="secretKey"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {mode.type === "edit" ? t("secretKeyEdit") : t("secretKey")}
              </FormLabel>
              <FormControl>
                <PasswordInput
                  autoComplete="new-password"
                  placeholder={
                    mode.type === "edit"
                      ? t("secretKeyEditPlaceholder")
                      : undefined
                  }
                  {...field}
                  onChange={(e) => {
                    resetTest();
                    field.onChange(e);
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="forcePathStyle"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <FormLabel>{t("forcePathStyle")}</FormLabel>
                <FormDescription>
                  {t("forcePathStyleDescription")}
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={(v) => {
                    resetTest();
                    field.onChange(v);
                  }}
                />
              </FormControl>
            </FormItem>
          )}
        />

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

        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push("/storage")}
            disabled={loading}
          >
            {tCommon("cancel")}
          </Button>
          <Button type="submit" disabled={loading}>
            {loading
              ? t("submitting")
              : mode.type === "edit"
                ? t("saveChanges")
                : t("create")}
          </Button>
        </div>
      </form>
    </Form>
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
