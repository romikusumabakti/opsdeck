import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { AdvancedOptions } from "@/components/advanced-options";
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
import { domainErrorCode } from "@/lib/domains/errors";
import type { Serialized } from "@/web/api/client";
import {
  createCloudflareZone,
  testCloudflareZone,
  updateCloudflareZone,
} from "@/web/api/tunnels";

type Mode =
  | { type: "create" }
  | { type: "edit"; zone: Serialized<SafeCloudflareZone> };

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "fail"; message: string };

/**
 * `hasAccount`: a Cloudflare account token is set up, so the zone's own token
 * is optional (its DNS calls fall back to the account's) and sits under
 * Advanced options.
 */
export function CloudflareZoneForm({
  mode,
  hasAccount,
}: {
  mode: Mode;
  hasAccount: boolean;
}) {
  const t = useTranslations("zoneForm");
  const tCommon = useTranslations("common");
  const tDomains = useTranslations("domains");
  const router = useRouter();
  const initial = mode.type === "edit" ? mode.zone : null;

  const schema = z.object({
    name: z
      .string()
      .min(1, tCommon("required"))
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, t("nameInvalid")),
    zoneId: z.string().regex(/^[0-9a-f]{32}$/, t("zoneIdInvalid")),
    // Required on create without an account; on edit, blank means "keep the
    // stored token".
    apiToken:
      mode.type === "create" && !hasAccount
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

  // A refusal the domain APIs share (no account, …) is shown translated.
  function errorText(message: string): string {
    const code = domainErrorCode(message);
    return code ? tDomains(`errors.${code}`) : message;
  }

  async function onSubmit(values: z.infer<typeof schema>) {
    const shared = { name: values.name.trim(), zoneId: values.zoneId.trim() };

    if (mode.type === "create") {
      const result = await createCloudflareZone(
        values.apiToken.length > 0
          ? { ...shared, apiToken: values.apiToken }
          : shared
      );
      if (!result.success) {
        toast.error(errorText(result.message));
        return;
      }
      toast.success(result.message ?? "");
      router.push("/admin/cloudflare");
      return;
    }

    const patch: Record<string, unknown> = { ...shared };
    if (values.apiToken.length > 0) patch.apiToken = values.apiToken;

    const result = await updateCloudflareZone(mode.zone.id, patch);
    if (!result.success) {
      toast.error(errorText(result.message));
      return;
    }
    toast.success(result.message ?? "");
    router.push("/admin/cloudflare");
  }

  const loading = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !loading);

  const canTest =
    /^[0-9a-f]{32}$/.test(watched.zoneId.trim()) &&
    (watched.apiToken.length > 0 || mode.type === "edit" || hasAccount) &&
    testState.kind !== "testing" &&
    !loading;

  const tokenField = (
    <FormField
      control={form.control}
      name="apiToken"
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t("apiToken")}</FormLabel>
          <FormControl>
            <PasswordInput
              placeholder={
                mode.type === "edit" && mode.zone.hasToken
                  ? t("apiTokenKeep")
                  : undefined
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
          <FormDescription>
            {hasAccount
              ? t("apiTokenOptionalDescription")
              : t("apiTokenDescription")}
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );

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
        {hasAccount ? (
          // Open when the zone already carries its own token, so it shows.
          <AdvancedOptions
            defaultOpen={mode.type === "edit" && mode.zone.hasToken}
          >
            {tokenField}
          </AdvancedOptions>
        ) : (
          tokenField
        )}

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
            onClick={() => router.push("/admin/cloudflare")}
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
