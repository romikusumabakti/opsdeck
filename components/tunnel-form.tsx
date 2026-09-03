"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { createTunnel, updateTunnel } from "@/actions/tunnels";
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
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";
import type { Tunnel } from "@/lib/db/schema";

export type ServerOption = { id: string; name: string; host: string };
export type ZoneOption = { id: string; name: string };

type Mode = { type: "create" } | { type: "edit"; tunnel: Tunnel };

/**
 * Register an EXISTING tunnel with the panel.
 *
 * Deliberately not a "create tunnel" form. Creating one needs the account-wide
 * origin certificate, which authorises publishing hostnames anywhere in the
 * zone — a far broader credential than the zone-scoped DNS token this panel
 * stores, and one the runbook shreds after every use. Creating tunnels stays a
 * manual, audited step; this form only records where an existing one lives.
 */
export function TunnelForm({
  mode,
  servers,
  zones,
}: {
  mode: Mode;
  servers: ServerOption[];
  zones: ZoneOption[];
}) {
  const t = useTranslations("tunnelForm");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const initial = mode.type === "edit" ? mode.tunnel : null;

  const schema = z.object({
    name: z.string().min(1, tCommon("required")),
    zoneId: z.string().min(1, tCommon("required")),
    serverId: z.string().min(1, tCommon("required")),
    tunnelId: z.uuid(t("tunnelIdInvalid")),
    stackDir: z
      .string()
      .min(1, tCommon("required"))
      .regex(/^\//, t("stackDirInvalid")),
    configPath: z.string().min(1, tCommon("required")),
    containerName: z.string().min(1, tCommon("required")),
  });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name ?? "",
      zoneId:
        initial?.zoneId ?? (zones.length === 1 ? (zones[0]?.id ?? "") : ""),
      serverId: initial?.serverId ?? "",
      tunnelId: initial?.tunnelId ?? "",
      stackDir: initial?.stackDir ?? "",
      configPath: initial?.configPath ?? "cloudflared/config.yml",
      containerName: initial?.containerName ?? "",
    },
  });

  async function onSubmit(values: z.infer<typeof schema>) {
    const payload = {
      ...values,
      name: values.name.trim(),
      stackDir: values.stackDir.trim().replace(/\/$/, ""),
      configPath: values.configPath.trim(),
      containerName: values.containerName.trim(),
    };
    const result =
      mode.type === "create"
        ? await createTunnel(payload)
        : await updateTunnel(mode.tunnel.id, payload);

    if (!result.success) {
      toast.error(result.message);
      return;
    }
    toast.success(result.message ?? "");
    router.push("/admin/tunnels");
    router.refresh();
  }

  const loading = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !loading);

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
                <Input placeholder="dss-apps-136" {...field} />
              </FormControl>
              <FormDescription>{t("nameDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="tunnelId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("tunnelId")}</FormLabel>
              <FormControl>
                <Input
                  placeholder="421f7083-06b9-4e64-98ec-d64df7e14e41"
                  className="font-mono"
                  {...field}
                />
              </FormControl>
              <FormDescription>{t("tunnelIdDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="zoneId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("zone")}</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={t("zonePlaceholder")} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {zones.map((zone) => (
                    <SelectItem key={zone.id} value={zone.id}>
                      {zone.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>{t("zoneDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="serverId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("server")}</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={t("serverPlaceholder")} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {servers.map((server) => (
                    <SelectItem key={server.id} value={server.id}>
                      {server.name}
                      <span className="ml-2 text-xs text-muted-foreground font-mono">
                        {server.host}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>{t("serverDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="stackDir"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("stackDir")}</FormLabel>
              <FormControl>
                <Input
                  placeholder="/opt/stacks/apps-tunnel"
                  className="font-mono"
                  {...field}
                />
              </FormControl>
              <FormDescription>{t("stackDirDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="configPath"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("configPath")}</FormLabel>
              <FormControl>
                <Input className="font-mono" {...field} />
              </FormControl>
              <FormDescription>{t("configPathDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="containerName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("containerName")}</FormLabel>
              <FormControl>
                <Input
                  placeholder="apps-cloudflared"
                  className="font-mono"
                  {...field}
                />
              </FormControl>
              <FormDescription>{t("containerNameDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={loading}>
            {mode.type === "create" ? t("register") : tCommon("save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => router.push("/admin/tunnels")}
          >
            {tCommon("cancel")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
