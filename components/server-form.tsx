"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  createServer,
  testServerConnection,
  updateServer,
} from "@/actions/servers";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { useRouter } from "@/i18n/navigation";
import type { Server } from "@/lib/db/schema";

type Mode = { type: "create" } | { type: "edit"; server: Server };

type Props = {
  mode: Mode;
  /**
   * Optional callbacks to override default navigation behaviour. When provided,
   * the form skips `router.push("/servers")` so it can be embedded in a modal.
   */
  onSuccess?: (server: Server) => void;
  onCancel?: () => void;
};

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "fail"; message: string };

export function ServerForm({ mode, onSuccess, onCancel }: Props) {
  const t = useTranslations("serverForm");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const initial = mode.type === "edit" ? mode.server : null;

  const schema = z.object({
    name: z.string().min(1, tCommon("required")),
    host: z.string().min(1, tCommon("required")),
    username: z.string().min(1, tCommon("required")),
    password:
      mode.type === "create"
        ? z.string().min(1, tCommon("required"))
        : z.string(),
  });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name ?? "",
      host: initial?.host ?? "",
      username: initial?.username ?? "",
      password: "",
    },
  });

  const [testState, setTestState] = useState<TestState>({ kind: "idle" });

  function resetTest() {
    setTestState({ kind: "idle" });
  }

  const watched = form.watch();

  async function onTest() {
    setTestState({ kind: "testing" });
    const payload: {
      host: string;
      username: string;
      password?: string;
      serverId?: string;
    } = {
      host: watched.host.trim(),
      username: watched.username.trim(),
    };
    if (watched.password.length > 0) payload.password = watched.password;
    if (mode.type === "edit") payload.serverId = mode.server.id;

    const result = await testServerConnection(payload);
    if (result.ok) {
      setTestState({ kind: "ok" });
    } else {
      setTestState({ kind: "fail", message: result.message });
    }
  }

  async function onSubmit(values: z.infer<typeof schema>) {
    if (mode.type === "create") {
      const result = await createServer({
        name: values.name.trim(),
        host: values.host.trim(),
        username: values.username.trim(),
        password: values.password,
      });
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message ?? "");
      if (onSuccess) {
        onSuccess(result.data);
        return;
      }
      router.push("/servers");
      router.refresh();
      return;
    }

    const data: {
      name: string;
      host: string;
      username: string;
      password?: string;
    } = {
      name: values.name.trim(),
      host: values.host.trim(),
      username: values.username.trim(),
    };
    if (values.password.length > 0) data.password = values.password;

    const result = await updateServer(mode.server.id, data);
    if (!result.success) {
      toast.error(result.message);
      return;
    }
    toast.success(result.message ?? "");
    router.push("/servers");
    router.refresh();
  }

  function handleCancel() {
    if (onCancel) {
      onCancel();
      return;
    }
    router.push("/servers");
  }

  const loading = form.formState.isSubmitting;

  // Test button is enabled when host & username are filled, AND either a
  // password is typed or we're in edit mode (we can fall back to stored).
  const canTest =
    watched.host.trim().length > 0 &&
    watched.username.trim().length > 0 &&
    (watched.password.length > 0 || mode.type === "edit") &&
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
          name="host"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("host")}</FormLabel>
              <FormControl>
                <Input
                  placeholder="192.168.x.x"
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
          name="username"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("username")}</FormLabel>
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
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {mode.type === "edit" ? t("passwordEdit") : t("password")}
              </FormLabel>
              <FormControl>
                <PasswordInput
                  autoComplete="new-password"
                  placeholder={
                    mode.type === "edit"
                      ? t("passwordEditPlaceholder")
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
            onClick={handleCancel}
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
      <span className="text-sm text-green-600 dark:text-green-500 inline-flex items-center gap-1">
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
