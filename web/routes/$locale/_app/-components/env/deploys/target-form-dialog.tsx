import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  COMPONENT_OTHER_APP_MESSAGE,
  TAG_VARIABLE_IS_VARIABLE_MESSAGE,
} from "@/lib/deploy/errors";
import {
  branchSchema,
  componentKeySchema,
  deployDirSchema,
  envVarNameSchema,
  healthTimeoutSchema,
  healthUrlSchema,
  preStartCommandSchema,
  servicesSchema,
} from "@/lib/deploy/validation";
import { hasReservedPrefix } from "@/lib/variables/validation";
import { listAppsQuery } from "@/web/api/apps";
import { ApiError } from "@/web/api/client";
import { createDeployTarget, type DeployTargetState } from "@/web/api/deploys";
import type { EnvironmentWithServers } from "@/web/api/environments";

/**
 * The servers an environment's services run on, once each. A deploy target
 * must use one of them (the API rejects any other).
 */
export function environmentServers(
  environment: EnvironmentWithServers
): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const service of environment.services) {
    byId.set(service.server.id, service.server.name);
  }
  return [...byId].map(([id, name]) => ({ id, name }));
}

export const splitServices = (value: string) =>
  value.split(/[\s,]+/).filter((s) => s.length > 0);

/** A deploy target's settings as form strings and switches. */
export type TargetValues = {
  serverId: string;
  sourceBranch: string;
  deployDir: string;
  services: string;
  tagVariable: string;
  preStartCommand: string;
  healthUrl: string;
  healthTimeoutSeconds: string;
  autoDeploy: boolean;
  backupBeforeDeploy: boolean;
};

type Values = TargetValues & { componentKey: string };

/** The form values of a stored target, or of a new one (`target` null). */
export function targetFormValues(
  target: DeployTargetState | null,
  servers: { id: string }[]
): TargetValues {
  return {
    // One server is the common case; preselect it.
    serverId:
      target?.serverId ?? (servers.length === 1 ? (servers[0]?.id ?? "") : ""),
    sourceBranch: target?.sourceBranch ?? "",
    deployDir: target?.deployDir ?? "",
    services: target?.services.join(", ") ?? "",
    tagVariable: target?.tagVariable ?? "IMAGE_TAG",
    preStartCommand: target?.preStartCommand ?? "",
    healthUrl: target?.healthUrl ?? "",
    healthTimeoutSeconds: String(target?.healthTimeoutSeconds ?? 180),
    autoDeploy: target?.autoDeploy ?? false,
    backupBeforeDeploy: target?.backupBeforeDeploy ?? false,
  };
}

/** The API payload of a target's form values. */
export function targetSettings(values: TargetValues) {
  return {
    serverId: values.serverId,
    sourceBranch: values.sourceBranch.trim(),
    deployDir: values.deployDir.trim(),
    services: splitServices(values.services),
    tagVariable: values.tagVariable.trim(),
    preStartCommand: values.preStartCommand.trim() || null,
    healthUrl: values.healthUrl.trim() || null,
    healthTimeoutSeconds: Number(values.healthTimeoutSeconds),
    autoDeploy: values.autoDeploy,
    backupBeforeDeploy: values.backupBeforeDeploy,
  };
}

/** The API's own target field schemas, with the form's localized messages. */
export function useTargetSchema() {
  const t = useTranslations("deploys.form");
  const tCommon = useTranslations("common");
  const required = tCommon("required");
  const invalid = t("invalid");
  const matches = (schema: z.ZodType) => (value: string) =>
    schema.safeParse(value.trim()).success;
  const optional = (schema: z.ZodType) => (value: string) =>
    value.trim() === "" || schema.safeParse(value.trim()).success;
  return z.object({
    serverId: z.string().min(1, required),
    sourceBranch: z
      .string()
      .trim()
      .min(1, required)
      .refine(matches(branchSchema), invalid),
    deployDir: z
      .string()
      .trim()
      .min(1, required)
      .refine(matches(deployDirSchema), invalid),
    services: z
      .string()
      .trim()
      .min(1, required)
      .refine(
        (value) => servicesSchema.safeParse(splitServices(value)).success,
        invalid
      ),
    tagVariable: z
      .string()
      .trim()
      .min(1, required)
      .refine(matches(envVarNameSchema), invalid)
      .refine((value) => !hasReservedPrefix(value), t("tagVariableReserved")),
    preStartCommand: z
      .string()
      .refine(optional(preStartCommandSchema), invalid),
    healthUrl: z.string().refine(optional(healthUrlSchema), invalid),
    healthTimeoutSeconds: z
      .string()
      .trim()
      .refine(
        (value) =>
          /^\d+$/.test(value) &&
          healthTimeoutSchema.safeParse(Number(value)).success,
        invalid
      ),
    autoDeploy: z.boolean(),
    backupBeforeDeploy: z.boolean(),
  });
}

/**
 * Adds a deploy target. Existing targets are edited on the environment's
 * Settings → Source & Deploy tab. With an app on the environment the
 * component is picked from the app's components (the one not yet targeted
 * preselected when it is the only one); a legacy environment without an app
 * types the component key.
 */
export function TargetFormDialog({
  open,
  onOpenChange,
  environment,
  servers,
  targetedKeys = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: Pick<EnvironmentWithServers, "id" | "appId">;
  // The servers the environment's services run on (environmentServers).
  servers: { id: string; name: string }[];
  // The component keys that already have a target in this environment.
  targetedKeys?: string[];
}) {
  const t = useTranslations("deploys.form");
  const tCommon = useTranslations("common");
  const appId = environment.appId ?? null;
  // Apps and their public components are listed for every signed-in user.
  const apps = useQuery({ ...listAppsQuery(), enabled: appId !== null }).data;
  const components = appId
    ? apps?.find((app) => app.id === appId)?.components
    : undefined;
  const taken = new Set(targetedKeys);
  const free = components?.filter((c) => !taken.has(c.componentKey)) ?? [];

  const invalid = t("invalid");
  const schema = useTargetSchema().extend({
    componentKey: z
      .string()
      .trim()
      .min(1, tCommon("required"))
      .refine((value) => componentKeySchema.safeParse(value).success, invalid),
  });
  const defaults = (): Values => ({
    componentKey: free.length === 1 ? (free[0]?.componentKey ?? "") : "",
    ...targetFormValues(null, servers),
  });

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: defaults(),
  });

  // Start from a blank form on every open (and once the app's components
  // arrive, to preselect).
  const loaded = components !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open only
  React.useEffect(() => {
    if (open) form.reset(defaults());
  }, [open, loaded]);

  async function onSubmit(values: Values) {
    try {
      await createDeployTarget({
        ...targetSettings(values),
        environmentId: environment.id,
        componentKey: values.componentKey.trim(),
      });
      toast.success(t("created"));
      onOpenChange(false);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.message === TAG_VARIABLE_IS_VARIABLE_MESSAGE
      ) {
        form.setError("tagVariable", { message: t("tagVariableIsVariable") });
      } else if (error instanceof ApiError && error.status === 404) {
        form.setError("componentKey", { message: t("componentNotFound") });
      } else if (error instanceof ApiError && error.status === 409) {
        form.setError("componentKey", {
          message:
            error.message === COMPONENT_OTHER_APP_MESSAGE
              ? t("otherApp")
              : t("duplicateComponent"),
        });
      } else {
        toast.error(
          error instanceof Error ? error.message : tCommon("errorGeneric")
        );
      }
    }
  }

  const text = (
    name: Exclude<
      keyof Values,
      "serverId" | "autoDeploy" | "backupBeforeDeploy"
    >,
    props: React.ComponentProps<typeof Input> = {}
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t(name)}</FormLabel>
          <FormControl>
            <Input
              autoComplete="off"
              spellCheck={false}
              {...field}
              {...props}
            />
          </FormControl>
          <FormDescription>{t(`${name}Hint`)}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const toggle = (name: "autoDeploy" | "backupBeforeDeploy") => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex items-center gap-2">
          <FormControl>
            <Switch checked={field.value} onCheckedChange={field.onChange} />
          </FormControl>
          <FormLabel className="font-normal">{t(name)}</FormLabel>
        </FormItem>
      )}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDescription")}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
          >
            {components ? (
              <FormField
                control={form.control}
                name="componentKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="target-component">
                      {t("component")}
                    </FormLabel>
                    <Select
                      value={field.value || null}
                      items={Object.fromEntries(
                        components.map((c) => [
                          c.componentKey,
                          `${c.componentKey} (${c.repoFullName})`,
                        ])
                      )}
                      onValueChange={(value) => field.onChange(value ?? "")}
                    >
                      <FormControl>
                        <SelectTrigger id="target-component" className="w-full">
                          <SelectValue
                            placeholder={t("componentPlaceholder")}
                          />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {components.map((c) => (
                          <SelectItem
                            key={c.componentKey}
                            value={c.componentKey}
                            disabled={taken.has(c.componentKey)}
                          >
                            <span className="font-mono">{c.componentKey}</span>
                            <span className="text-muted-foreground">
                              {c.repoFullName}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>{t("componentHint")}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              text("componentKey", { placeholder: "dplk-accounting" })
            )}
            <FormField
              control={form.control}
              name="serverId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("server")}</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => field.onChange(value ?? "")}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t("serverPlaceholder")} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {servers.map((server) => (
                        <SelectItem key={server.id} value={server.id}>
                          {server.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>{t("serverHint")}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            {text("sourceBranch", { placeholder: "kestrel/development" })}
            {text("deployDir", { placeholder: "/opt/dplk-accounting" })}
            {text("services", { placeholder: "backend, frontend" })}
            {text("tagVariable")}
            {text("preStartCommand")}
            {text("healthUrl", {
              inputMode: "url",
              placeholder: "http://localhost:8080/health",
            })}
            {text("healthTimeoutSeconds", { inputMode: "numeric" })}
            {toggle("autoDeploy")}
            {toggle("backupBeforeDeploy")}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {t("create")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
