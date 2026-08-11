"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Unlink,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  saveJiraLink,
  syncJiraProjectNow,
  unlinkJiraProject,
} from "@/actions/jira";
import { useDialog } from "@/components/dialog-provider";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useRouter } from "@/i18n/navigation";
import type {
  JiraLinkWithConnection,
  SafeJiraConnection,
} from "@/lib/db/schema";

/**
 * The Jira tab of project settings: bind this project to a Jira project, and
 * drive the sweep from there.
 *
 * Every button here only *queues* work — the sweep runs on the worker, so the
 * card reports the last recorded outcome rather than pretending to be live.
 */
export function JiraLinkCard({
  projectId,
  connections,
  link,
}: {
  projectId: string;
  connections: SafeJiraConnection[];
  link: JiraLinkWithConnection | null;
}) {
  const t = useTranslations("jiraLink");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const dialog = useDialog();
  const format = useFormatter();
  const [isPending, startTransition] = useTransition();

  const schema = z.object({
    connectionId: z.string().min(1, tCommon("required")),
    jiraProjectKey: z
      .string()
      .trim()
      .min(2, tCommon("required"))
      .regex(/^[A-Za-z][A-Za-z0-9_]{1,50}$/, t("keyInvalid")),
    jqlFilter: z.string(),
    enabled: z.boolean(),
    pushEnabled: z.boolean(),
  });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      connectionId: link?.connectionId ?? connections[0]?.id ?? "",
      jiraProjectKey: link?.jiraProjectKey ?? "",
      jqlFilter: link?.jqlFilter ?? "",
      enabled: link?.enabled ?? true,
      pushEnabled: link?.pushEnabled ?? false,
    },
  });

  async function onSubmit(values: z.infer<typeof schema>) {
    const result = await saveJiraLink({
      projectId,
      connectionId: values.connectionId,
      jiraProjectKey: values.jiraProjectKey.trim().toUpperCase(),
      jqlFilter:
        values.jqlFilter.trim().length > 0 ? values.jqlFilter.trim() : null,
      enabled: values.enabled,
      pushEnabled: values.pushEnabled,
    });
    if (!result.success) {
      toast.error(result.message);
      return;
    }
    toast.success(result.message ?? "");
    router.refresh();
  }

  function onSync(full: boolean) {
    startTransition(async () => {
      const result = await syncJiraProjectNow(projectId, full);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message ?? "");
      router.refresh();
    });
  }

  async function onUnlink() {
    const ok = await dialog.confirm({
      title: t("unlinkTitle"),
      description: t("unlinkDescription"),
      confirmText: t("unlink"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await unlinkJiraProject(projectId);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message ?? "");
      router.refresh();
    });
  }

  if (connections.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t("noConnections")}</p>
    );
  }

  const loading = form.formState.isSubmitting || isPending;

  return (
    <div className="flex flex-col gap-6">
      {link && <SyncStatus link={link} t={t} format={format} />}

      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-col gap-4"
        >
          <FormField
            control={form.control}
            name="connectionId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("connection")}</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={t("connectionPlaceholder")} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {connections.map((connection) => (
                      <SelectItem key={connection.id} value={connection.id}>
                        {connection.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="jiraProjectKey"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("projectKey")}</FormLabel>
                <FormControl>
                  <Input placeholder="CMEM" className="font-mono" {...field} />
                </FormControl>
                <FormDescription>{t("projectKeyDescription")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="jqlFilter"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("jqlFilter")}</FormLabel>
                <FormControl>
                  <Input
                    placeholder="labels = opsdeck"
                    className="font-mono"
                    {...field}
                  />
                </FormControl>
                <FormDescription>{t("jqlFilterDescription")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <FormLabel>{t("enabled")}</FormLabel>
                  <FormDescription>{t("enabledDescription")}</FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="pushEnabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <FormLabel>{t("pushEnabled")}</FormLabel>
                  <FormDescription>
                    {t("pushEnabledDescription")}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <div className="flex flex-wrap gap-2">
              {link && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onSync(false)}
                    disabled={loading}
                  >
                    <RefreshCw className="size-4" />
                    {t("syncNow")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onSync(true)}
                    disabled={loading}
                  >
                    {t("fullResync")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onUnlink}
                    disabled={loading}
                    className="text-destructive"
                  >
                    <Unlink className="size-4" />
                    {t("unlink")}
                  </Button>
                </>
              )}
            </div>
            <Button type="submit" disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : null}
              {link ? t("save") : t("link")}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}

/** Last recorded sweep outcome. `null` status = linked but never swept yet. */
function SyncStatus({
  link,
  t,
  format,
}: {
  link: JiraLinkWithConnection;
  t: (key: string, values?: Record<string, string>) => string;
  format: ReturnType<typeof useFormatter>;
}) {
  const failed = link.lastSyncStatus === "failed";
  const partial = link.lastSyncStatus === "partial";
  const remoteUrl = `${link.connection.baseUrl}/browse/${link.jiraProjectKey}`;

  return (
    <div className="rounded-lg border bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {failed || partial ? (
          <AlertCircle
            className={
              failed
                ? "size-4 text-destructive"
                : "size-4 text-amber-600 dark:text-amber-500"
            }
          />
        ) : (
          <CheckCircle2 className="size-4 text-success" />
        )}
        <span className="font-medium">
          {t(`status_${link.lastSyncStatus ?? "pending"}`)}
        </span>
        {link.lastSyncAt && (
          <span className="text-muted-foreground">
            ·{" "}
            {format.dateTime(new Date(link.lastSyncAt), {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
        )}
        <a
          className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          href={remoteUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          {link.jiraProjectKey} ↗
        </a>
      </div>
      {link.lastSyncError && (
        <p className="mt-2 break-all font-mono text-xs text-destructive">
          {link.lastSyncError}
        </p>
      )}
    </div>
  );
}
