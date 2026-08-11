"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  createJiraConnection,
  testJiraConnection,
  updateJiraConnection,
} from "@/actions/jira";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";
import type { SafeJiraConnection } from "@/lib/db/schema";

type Mode =
  | { type: "create" }
  | { type: "edit"; connection: SafeJiraConnection };

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; account: string }
  | { kind: "fail"; message: string };

export function JiraConnectionForm({ mode }: { mode: Mode }) {
  const t = useTranslations("jiraForm");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const initial = mode.type === "edit" ? mode.connection : null;

  const schema = z
    .object({
      name: z.string().min(1, tCommon("required")),
      baseUrl: z.url(t("baseUrlInvalid")),
      flavor: z.enum(["cloud", "datacenter"]),
      email: z.string(),
      // Required on create; on edit, blank means "keep the stored token".
      apiToken:
        mode.type === "create"
          ? z.string().min(1, tCommon("required"))
          : z.string(),
    })
    // Cloud authenticates as email:token over Basic. Data Center's PAT is a
    // bearer token with no paired username, so the field is hidden and unused.
    .refine((v) => v.flavor !== "cloud" || v.email.trim().length > 0, {
      message: tCommon("required"),
      path: ["email"],
    });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name ?? "",
      baseUrl: initial?.baseUrl ?? "",
      flavor: initial?.flavor ?? "cloud",
      email: initial?.email ?? "",
      apiToken: "",
    },
  });

  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const resetTest = () => setTestState({ kind: "idle" });
  const watched = form.watch();
  const isCloud = watched.flavor === "cloud";

  async function onTest() {
    setTestState({ kind: "testing" });
    const result = await testJiraConnection({
      baseUrl: watched.baseUrl.trim(),
      flavor: watched.flavor,
      email: isCloud ? watched.email.trim() : null,
      apiToken: watched.apiToken.length > 0 ? watched.apiToken : undefined,
      connectionId: mode.type === "edit" ? mode.connection.id : undefined,
    });
    setTestState(
      result.ok
        ? { kind: "ok", account: result.account }
        : { kind: "fail", message: result.message }
    );
  }

  async function onSubmit(values: z.infer<typeof schema>) {
    const shared = {
      name: values.name.trim(),
      baseUrl: values.baseUrl.trim(),
      flavor: values.flavor,
      email: values.flavor === "cloud" ? values.email.trim() : null,
    };

    if (mode.type === "create") {
      const result = await createJiraConnection({
        ...shared,
        apiToken: values.apiToken,
      });
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message ?? "");
      router.push("/admin/jira");
      router.refresh();
      return;
    }

    const patch: Record<string, unknown> = { ...shared };
    if (values.apiToken.length > 0) patch.apiToken = values.apiToken;

    const result = await updateJiraConnection(mode.connection.id, patch);
    if (!result.success) {
      toast.error(result.message);
      return;
    }
    toast.success(result.message ?? "");
    router.push("/admin/jira");
    router.refresh();
  }

  const loading = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !loading);

  const canTest =
    watched.baseUrl.trim().length > 0 &&
    (!isCloud || watched.email.trim().length > 0) &&
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
                <Input placeholder={t("namePlaceholder")} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="baseUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("baseUrl")}</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://acme.atlassian.net"
                  {...field}
                  onChange={(e) => {
                    resetTest();
                    field.onChange(e);
                  }}
                />
              </FormControl>
              <FormDescription>{t("baseUrlDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="flavor"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("flavor")}</FormLabel>
              <Select
                value={field.value}
                onValueChange={(value) => {
                  resetTest();
                  field.onChange(value);
                }}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="cloud">{t("flavorCloud")}</SelectItem>
                  <SelectItem value="datacenter">
                    {t("flavorDatacenter")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>{t("flavorDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        {isCloud && (
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("email")}</FormLabel>
                <FormControl>
                  <Input
                    autoComplete="off"
                    placeholder="service-account@acme.com"
                    {...field}
                    onChange={(e) => {
                      resetTest();
                      field.onChange(e);
                    }}
                  />
                </FormControl>
                <FormDescription>{t("emailDescription")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        <FormField
          control={form.control}
          name="apiToken"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{isCloud ? t("apiToken") : t("pat")}</FormLabel>
              <FormControl>
                <PasswordInput
                  autoComplete="new-password"
                  placeholder={
                    mode.type === "edit"
                      ? t("apiTokenEditPlaceholder")
                      : undefined
                  }
                  {...field}
                  onChange={(e) => {
                    resetTest();
                    field.onChange(e);
                  }}
                />
              </FormControl>
              <FormDescription>
                {isCloud ? t("apiTokenDescription") : t("patDescription")}
              </FormDescription>
              <FormMessage />
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
            onClick={() => router.push("/admin/jira")}
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
  t: (key: string, values?: Record<string, string>) => string;
}) {
  if (state.kind === "idle" || state.kind === "testing") return null;
  if (state.kind === "ok") {
    return (
      <span className="text-sm text-success inline-flex items-center gap-1">
        <CheckCircle2 className="size-4" />
        {t("testSuccess", { account: state.account })}
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
