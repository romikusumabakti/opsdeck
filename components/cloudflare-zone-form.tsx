"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  createCloudflareZone,
  testCloudflareZone,
  updateCloudflareZone,
} from "@/actions/tunnels";
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
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";
import type { SafeCloudflareZone } from "@/lib/db/schema";

type Mode = { type: "create" } | { type: "edit"; zone: SafeCloudflareZone };

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "fail"; message: string };

export function CloudflareZoneForm({ mode }: { mode: Mode }) {
  const t = useTranslations("zoneForm");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const initial = mode.type === "edit" ? mode.zone : null;

  const schema = z.object({
    name: z
      .string()
      .min(1, tCommon("required"))
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, t("nameInvalid")),
    zoneId: z.string().regex(/^[0-9a-f]{32}$/, t("zoneIdInvalid")),
    // Required on create; on edit, blank means "keep the stored token".
    apiToken:
      mode.type === "create"
        ? z.string().min(1, tCommon("required"))
        : z.string(),
  });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name ?? "",
      zoneId: initial?.zoneId ?? "",
      apiToken: "",
    },
  });

  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const resetTest = () => setTestState({ kind: "idle" });
  const watched = form.watch();

  async function onTest() {
    setTestState({ kind: "testing" });
    const result = await testCloudflareZone({
      zoneId: watched.zoneId.trim(),
      apiToken: watched.apiToken.length > 0 ? watched.apiToken : undefined,
      id: mode.type === "edit" ? mode.zone.id : undefined,
    });
    setTestState(
      result.ok ? { kind: "ok" } : { kind: "fail", message: result.message }
    );
  }

  async function onSubmit(values: z.infer<typeof schema>) {
    const shared = { name: values.name.trim(), zoneId: values.zoneId.trim() };

    if (mode.type === "create") {
      const result = await createCloudflareZone({
        ...shared,
        apiToken: values.apiToken,
      });
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message ?? "");
      router.push("/admin/tunnels/zones");
      router.refresh();
      return;
    }

    const patch: Record<string, unknown> = { ...shared };
    if (values.apiToken.length > 0) patch.apiToken = values.apiToken;

    const result = await updateCloudflareZone(mode.zone.id, patch);
    if (!result.success) {
      toast.error(result.message);
      return;
    }
    toast.success(result.message ?? "");
    router.push("/admin/tunnels/zones");
    router.refresh();
  }

  const loading = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !loading);

  const canTest =
    /^[0-9a-f]{32}$/.test(watched.zoneId.trim()) &&
    (watched.apiToken.length > 0 || mode.type === "edit") &&
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
                <Input
                  placeholder="example.com"
                  className="font-mono"
                  {...field}
                />
              </FormControl>
              <FormDescription>{t("nameDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="zoneId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("zoneId")}</FormLabel>
              <FormControl>
                <Input
                  className="font-mono"
                  {...field}
                  onChange={(e) => {
                    resetTest();
                    field.onChange(e);
                  }}
                />
              </FormControl>
              <FormDescription>{t("zoneIdDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="apiToken"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("apiToken")}</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder={
                    mode.type === "edit" ? t("apiTokenKeep") : undefined
                  }
                  {...field}
                  onChange={(e) => {
                    resetTest();
                    field.onChange(e);
                  }}
                />
              </FormControl>
              {/* The scope matters more than the value: this token should be
                  able to edit DNS in one zone and nothing else. */}
              <FormDescription>{t("apiTokenDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={loading}>
            {mode.type === "create" ? t("add") : tCommon("save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!canTest}
            onClick={onTest}
          >
            {testState.kind === "testing" && (
              <Loader2 className="size-4 animate-spin" />
            )}
            {t("test")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={loading}
            onClick={() => router.push("/admin/tunnels/zones")}
          >
            {tCommon("cancel")}
          </Button>
        </div>

        {testState.kind === "ok" && (
          <p className="flex items-center gap-2 text-sm text-green-600 dark:text-green-500">
            <CheckCircle2 className="size-4" />
            {t("testOk")}
          </p>
        )}
        {testState.kind === "fail" && (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <XCircle className="size-4" />
            {testState.message}
          </p>
        )}
      </form>
    </Form>
  );
}
