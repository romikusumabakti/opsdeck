"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { PlugZap } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  type MailpitSettings,
  saveMailpitSettings,
  testMailpitConnection,
} from "@/actions/mailpit-settings";
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
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";

export function MailpitSettingsForm({
  environmentId,
  settings,
}: {
  environmentId: string;
  settings: MailpitSettings | null;
}) {
  const t = useTranslations("mailpitSettings");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [testing, startTesting] = useTransition();

  const schema = z.object({
    url: z.union([
      z.literal(""),
      z
        .string()
        .trim()
        .url(tCommon("urlInvalid"))
        .refine((v) => /^https?:\/\//i.test(v), tCommon("urlInvalid")),
    ]),
    username: z.string(),
    // Blank = keep the stored password (see actions/mailpit-settings).
    password: z.string(),
  });
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      url: settings?.url ?? "",
      username: settings?.username ?? "",
      password: "",
    },
  });
  const url = useWatch({ control: form.control, name: "url" });
  const saving = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !saving);

  function payload(values: Values) {
    return {
      url: values.url.trim(),
      username: values.username.trim() || null,
      password: values.password || undefined,
    };
  }

  async function onSubmit(values: Values) {
    const result = await saveMailpitSettings(environmentId, payload(values));
    if (!result.success) {
      toast.error(result.message || t("saveFailed"));
      return;
    }
    toast.success(values.url.trim() ? t("saved") : t("removed"));
    form.reset({ ...values, password: "" });
    router.refresh();
  }

  function onTest() {
    startTesting(async () => {
      if (!(await form.trigger("url"))) return;
      const result = await testMailpitConnection(
        environmentId,
        payload(form.getValues())
      );
      if (result.success) {
        toast.success(
          t("testOk", {
            version: result.data.version,
            count: result.data.messages,
          })
        );
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-4"
      >
        <FormField
          control={form.control}
          name="url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("url")}</FormLabel>
              <FormControl>
                <Input
                  type="url"
                  placeholder="https://mail-qa.example.com/"
                  {...field}
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">{t("urlHint")}</p>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="username"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("username")}</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
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
                <FormLabel>{t("password")}</FormLabel>
                <FormControl>
                  <PasswordInput
                    autoComplete="new-password"
                    placeholder={
                      settings?.hasPassword ? t("passwordKeepPlaceholder") : ""
                    }
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("authHint")}</p>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onTest}
            disabled={testing || saving || !url.trim()}
          >
            <PlugZap className="size-4" />
            {testing ? t("testing") : t("test")}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
