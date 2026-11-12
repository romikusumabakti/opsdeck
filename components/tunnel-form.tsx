import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
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
import type { Serialized } from "@/web/api/client";
import { createTunnel, updateTunnel } from "@/web/api/tunnels";

export type ServerOption = { id: string; name: string; host: string };
export type ZoneOption = { id: string; name: string };

type Mode = { type: "create" } | { type: "edit"; tunnel: Serialized<Tunnel> };

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
    router.push("/admin/cloudflare");
  }

  const loading = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !loading);

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="tunnel-name">{t("name")}</FieldLabel>
              <Input
                placeholder="dss-apps-136"
                {...field}
                id="tunnel-name"
                aria-invalid={fieldState.invalid}
              />
              <FieldDescription>{t("nameDescription")}</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="tunnelId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="tunnel-tunnel-id">
                {t("tunnelId")}
              </FieldLabel>
              <Input
                placeholder="421f7083-06b9-4e64-98ec-d64df7e14e41"
                className="font-mono"
                {...field}
                id="tunnel-tunnel-id"
                aria-invalid={fieldState.invalid}
              />
              <FieldDescription>{t("tunnelIdDescription")}</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="zoneId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="tunnel-zone-id">{t("zone")}</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger
                  id="tunnel-zone-id"
                  aria-invalid={fieldState.invalid}
                >
                  <SelectValue placeholder={t("zonePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {zones.map((zone) => (
                    <SelectItem key={zone.id} value={zone.id}>
                      {zone.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{t("zoneDescription")}</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="serverId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="tunnel-server-id">{t("server")}</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger
                  id="tunnel-server-id"
                  aria-invalid={fieldState.invalid}
                >
                  <SelectValue placeholder={t("serverPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((server) => (
                    <SelectItem key={server.id} value={server.id}>
                      {server.name}
                      <span className="ml-2 text-sm text-muted-foreground font-mono">
                        {server.host}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{t("serverDescription")}</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="stackDir"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="tunnel-stack-dir">
                {t("stackDir")}
              </FieldLabel>
              <Input
                placeholder="/opt/stacks/apps-tunnel"
                className="font-mono"
                {...field}
                id="tunnel-stack-dir"
                aria-invalid={fieldState.invalid}
              />
              <FieldDescription>{t("stackDirDescription")}</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="configPath"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="tunnel-config-path">
                {t("configPath")}
              </FieldLabel>
              <Input
                className="font-mono"
                {...field}
                id="tunnel-config-path"
                aria-invalid={fieldState.invalid}
              />
              <FieldDescription>{t("configPathDescription")}</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="containerName"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="tunnel-container-name">
                {t("containerName")}
              </FieldLabel>
              <Input
                placeholder="apps-cloudflared"
                className="font-mono"
                {...field}
                id="tunnel-container-name"
                aria-invalid={fieldState.invalid}
              />
              <FieldDescription>
                {t("containerNameDescription")}
              </FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
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
            onClick={() => router.push("/admin/cloudflare")}
          >
            {tCommon("cancel")}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
