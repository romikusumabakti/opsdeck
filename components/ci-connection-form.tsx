import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
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
import {
  type CiConnectionRow,
  updateCiConnection,
} from "@/web/api/ci-connections";
import { ApiError } from "@/web/api/client";

export function CiConnectionForm({
  connection,
}: {
  connection: CiConnectionRow;
}) {
  const t = useTranslations("ciForm");
  const tCommon = useTranslations("common");
  const router = useRouter();
  // A blank token field keeps the stored value; these ask to clear it instead.
  const [clearApiToken, setClearApiToken] = useState(false);
  const [clearForgeToken, setClearForgeToken] = useState(false);

  const schema = z.object({
    name: z.string().trim().min(1, tCommon("required")),
    baseUrl: z.url(t("baseUrlInvalid")),
    apiToken: z.string(),
    forgeUsername: z.string(),
    forgeToken: z.string(),
  });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: connection.name,
      baseUrl: connection.baseUrl,
      apiToken: "",
      forgeUsername: connection.forgeUsername ?? "",
      forgeToken: "",
    },
  });

  async function onSubmit(values: z.infer<typeof schema>) {
    const changes: Parameters<typeof updateCiConnection>[1] = {
      name: values.name.trim(),
      baseUrl: values.baseUrl.trim(),
      forgeUsername: values.forgeUsername.trim(),
    };
    if (clearApiToken) changes.apiToken = "";
    else if (values.apiToken.trim()) changes.apiToken = values.apiToken.trim();
    if (clearForgeToken) changes.forgeToken = "";
    else if (values.forgeToken.trim()) {
      changes.forgeToken = values.forgeToken.trim();
    }

    try {
      await updateCiConnection(connection.id, changes);
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(error.message);
        return;
      }
      throw error;
    }
    toast.success(t("saved"));
    form.reset(values);
    setClearApiToken(false);
    setClearForgeToken(false);
    router.push("/admin/ci");
  }

  const loading = form.formState.isSubmitting;
  useUnsavedChanges(
    (form.formState.isDirty || clearApiToken || clearForgeToken) && !loading
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
                <Input {...field} />
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
                <Input placeholder="https://ci.example.com" {...field} />
              </FormControl>
              <FormDescription>{t("baseUrlDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="apiToken"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center gap-2">
                <FormLabel>{t("apiToken")}</FormLabel>
                <Badge
                  variant={
                    connection.hasApiToken && !clearApiToken
                      ? "secondary"
                      : "outline"
                  }
                >
                  {connection.hasApiToken && !clearApiToken
                    ? t("set")
                    : t("notSet")}
                </Badge>
              </div>
              <FormControl>
                <PasswordInput
                  autoComplete="new-password"
                  disabled={clearApiToken}
                  placeholder={
                    connection.hasApiToken ? t("keepPlaceholder") : undefined
                  }
                  {...field}
                />
              </FormControl>
              <FormDescription>{t("apiTokenDescription")}</FormDescription>
              {connection.hasApiToken && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => setClearApiToken((v) => !v)}
                >
                  {clearApiToken ? t("keepStored") : t("clearStored")}
                </Button>
              )}
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="forgeUsername"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("forgeUsername")}</FormLabel>
              <FormControl>
                <Input autoComplete="off" {...field} />
              </FormControl>
              <FormDescription>{t("forgeUsernameDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="forgeToken"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center gap-2">
                <FormLabel>{t("forgeToken")}</FormLabel>
                <Badge
                  variant={
                    connection.hasForgeToken && !clearForgeToken
                      ? "secondary"
                      : "outline"
                  }
                >
                  {connection.hasForgeToken && !clearForgeToken
                    ? t("set")
                    : t("notSet")}
                </Badge>
              </div>
              <FormControl>
                <PasswordInput
                  autoComplete="new-password"
                  disabled={clearForgeToken}
                  placeholder={
                    connection.hasForgeToken ? t("keepPlaceholder") : undefined
                  }
                  {...field}
                />
              </FormControl>
              <FormDescription>{t("forgeTokenDescription")}</FormDescription>
              {connection.hasForgeToken && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => setClearForgeToken((v) => !v)}
                >
                  {clearForgeToken ? t("keepStored") : t("clearStored")}
                </Button>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push("/admin/ci")}
            disabled={loading}
          >
            {tCommon("cancel")}
          </Button>
          <Button type="submit" disabled={loading}>
            {loading ? t("submitting") : t("saveChanges")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
