import { zodResolver } from "@hookform/resolvers/zod";
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
  branchSchema,
  componentKeySchema,
  deployDirSchema,
  envVarNameSchema,
  healthTimeoutSchema,
  healthUrlSchema,
  preStartCommandSchema,
  servicesSchema,
} from "@/lib/deploy/validation";
import { ApiError } from "@/web/api/client";
import {
  createDeployTarget,
  type DeployTargetState,
  updateDeployTarget,
} from "@/web/api/deploys";
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

const splitServices = (value: string) =>
  value.split(/[\s,]+/).filter((s) => s.length > 0);

type Values = {
  componentKey: string;
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

function defaults(
  target: DeployTargetState | null,
  servers: { id: string }[]
): Values {
  return {
    componentKey: target?.componentKey ?? "",
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

/** Add a deploy target (`target` null) or edit one. */
export function TargetFormDialog({
  open,
  onOpenChange,
  environment,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: EnvironmentWithServers;
  target: DeployTargetState | null;
}) {
  const t = useTranslations("deploys.form");
  const tCommon = useTranslations("common");
  const servers = React.useMemo(
    () => environmentServers(environment),
    [environment]
  );

  // The API's own field schemas, with the form's localized messages.
  const required = tCommon("required");
  const invalid = t("invalid");
  const matches = (schema: z.ZodType) => (value: string) =>
    schema.safeParse(value.trim()).success;
  const optional = (schema: z.ZodType) => (value: string) =>
    value.trim() === "" || schema.safeParse(value.trim()).success;
  const schema = z.object({
    componentKey: z
      .string()
      .trim()
      .min(1, required)
      .refine(matches(componentKeySchema), invalid),
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
      .refine(matches(envVarNameSchema), invalid),
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

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: defaults(target, servers),
  });

  // Start from the target's saved values (or a blank form) on every open.
  React.useEffect(() => {
    if (open) form.reset(defaults(target, servers));
  }, [open, target, servers, form]);

  async function onSubmit(values: Values) {
    const settings = {
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
    try {
      if (target) {
        await updateDeployTarget(target.id, settings);
        toast.success(t("saved"));
      } else {
        await createDeployTarget({
          ...settings,
          environmentId: environment.id,
          componentKey: values.componentKey.trim(),
        });
        toast.success(t("created"));
      }
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ApiError && !target && error.status === 404) {
        form.setError("componentKey", { message: t("componentNotFound") });
      } else if (error instanceof ApiError && !target && error.status === 409) {
        form.setError("componentKey", { message: t("duplicateComponent") });
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
          <DialogTitle>{t(target ? "editTitle" : "createTitle")}</DialogTitle>
          <DialogDescription>
            {t(target ? "editDescription" : "createDescription")}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
          >
            {text("componentKey", {
              disabled: target !== null,
              placeholder: "dplk-accounting",
            })}
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
            {text("sourceBranch", { placeholder: "sucor/development" })}
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
                {t(target ? "save" : "create")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
