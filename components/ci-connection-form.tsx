import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleX,
  Loader2,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  type CiConnectionCheck,
  type CiConnectionRow,
  listCiConnectionsQuery,
  updateCiConnection,
  verifyCiConnection,
} from "@/web/api/ci-connections";
import { ApiError } from "@/web/api/client";

/** The connection's settings card: its details form under a short header. */
export function CiConnectionCard({
  connection,
  returnTo,
}: {
  connection: CiConnectionRow;
  returnTo?: string;
}) {
  const t = useTranslations("editCi");
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Workflow className="size-5 text-muted-foreground" />
          <CardTitle className="text-base">{t("formTitle")}</CardTitle>
        </div>
        <CardDescription>{t("formDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <CiConnectionForm connection={connection} returnTo={returnTo} />
        <CiConnectionVerify connectionId={connection.id} />
      </CardContent>
    </Card>
  );
}

/** Checks the saved CI token and forge credentials and shows the outcome. */
function CiConnectionVerify({ connectionId }: { connectionId: string }) {
  const t = useTranslations("ciForm");
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<CiConnectionCheck | null>(null);

  async function verify() {
    setChecking(true);
    try {
      setCheck(await verifyCiConnection(connectionId));
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(error.message);
        return;
      }
      throw error;
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => void verify()}
          disabled={checking}
        >
          {checking ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <ShieldCheck data-icon="inline-start" />
          )}
          {t("verify")}
        </Button>
        <p className="text-sm text-muted-foreground">
          {t("verifyDescription")}
        </p>
      </div>
      {check && (
        <ul className="flex flex-col gap-1.5 text-sm" aria-live="polite">
          <CheckLine
            label={t("verifyCi")}
            status={check.ci}
            reason={check.ciCode ? t(`verifyCodes.${check.ciCode}`) : null}
          />
          <CheckLine
            label={t("verifyForge")}
            status={check.forge}
            reason={
              check.forgeCode ? t(`verifyCodes.${check.forgeCode}`) : null
            }
          />
        </ul>
      )}
    </div>
  );
}

function CheckLine({
  label,
  status,
  reason,
}: {
  label: string;
  status: "ok" | "failed" | "notConfigured";
  reason: string | null;
}) {
  const t = useTranslations("ciForm");
  return (
    <li className="flex items-start gap-2" data-status={status}>
      {status === "ok" ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
      ) : status === "failed" ? (
        <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <CircleX className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <span>
        <span className="font-medium">{label}</span>{" "}
        {status === "ok"
          ? t("verifyOk")
          : status === "failed"
            ? t("verifyFailed")
            : t("verifyNotConfigured")}
        {reason && <span className="text-muted-foreground"> · {reason}</span>}
      </span>
    </li>
  );
}

export function CiConnectionForm({
  connection,
  returnTo,
}: {
  connection: CiConnectionRow;
  /**
   * Where Save and Cancel go. Without it the form stays on its page (the
   * single-connection CI page) and Cancel discards the edits.
   */
  returnTo?: string;
}) {
  const t = useTranslations("ciForm");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const queryClient = useQueryClient();
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
    // The presence badges come from the list: refetch it before showing the
    // form again, and empty the token fields (a saved token is never shown).
    await queryClient.invalidateQueries(listCiConnectionsQuery());
    form.reset({ ...values, apiToken: "", forgeToken: "" });
    setClearApiToken(false);
    setClearForgeToken(false);
    if (returnTo) router.push(returnTo);
  }

  function onCancel() {
    if (returnTo) {
      router.push(returnTo);
      return;
    }
    form.reset();
    setClearApiToken(false);
    setClearForgeToken(false);
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
            onClick={onCancel}
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
