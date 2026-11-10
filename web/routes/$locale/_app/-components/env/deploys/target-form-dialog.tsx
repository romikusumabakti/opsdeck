import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { type Resolver, useForm } from "react-hook-form";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
  jarNameSchema,
  preStartCommandSchema,
  servicesSchema,
  systemdUnitSchema,
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

export const TARGET_KINDS = ["compose", "jar", "static"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

const KIND_LABELS = {
  compose: "kindCompose",
  jar: "kindJar",
  static: "kindStatic",
} as const;

/** The `deploys.form` message key of a kind's name. */
export const kindLabelKey = (kind: TargetKind) => KIND_LABELS[kind];

/** The `deploys.form` message prefix of the directory field of a kind. */
export const deployDirCopy = (kind: TargetKind) =>
  kind === "jar" ? "jarDeployDir" : kind === "static" ? "webRoot" : "deployDir";

/**
 * Shows the pipeline-file failures a saved target returned, as the same
 * warning the new-environment form uses.
 */
export function usePipelineFailureNotice() {
  const t = useTranslations("newEnvironment");
  return (failures: { branch: string; componentKey: string }[]) => {
    for (const failure of failures) {
      toast.warning(
        t("pipelineFileNotCommitted", {
          branch: failure.branch,
          component: failure.componentKey,
        })
      );
    }
  };
}

/** A deploy target's settings as form strings and switches. */
export type TargetValues = {
  kind: TargetKind;
  serverId: string;
  sourceBranch: string;
  deployDir: string;
  jarName: string;
  systemdUnit: string;
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
    kind: target?.kind ?? "compose",
    // One server is the common case; preselect it.
    serverId:
      target?.serverId ?? (servers.length === 1 ? (servers[0]?.id ?? "") : ""),
    sourceBranch: target?.sourceBranch ?? "",
    deployDir: target?.deployDir ?? "",
    jarName: target?.jarName ?? "",
    systemdUnit: target?.systemdUnit ?? "",
    services: target?.services.join(", ") ?? "",
    tagVariable: target?.tagVariable ?? "IMAGE_TAG",
    preStartCommand: target?.preStartCommand ?? "",
    healthUrl: target?.healthUrl ?? "",
    healthTimeoutSeconds: String(target?.healthTimeoutSeconds ?? 180),
    autoDeploy: target?.autoDeploy ?? false,
    backupBeforeDeploy: target?.backupBeforeDeploy ?? false,
  };
}

function commonSettings(values: TargetValues) {
  return {
    serverId: values.serverId,
    sourceBranch: values.sourceBranch.trim(),
    deployDir: values.deployDir.trim(),
    healthTimeoutSeconds: Number(values.healthTimeoutSeconds),
    autoDeploy: values.autoDeploy,
  };
}

function composeSettings(values: TargetValues) {
  return {
    ...commonSettings(values),
    services: splitServices(values.services),
    tagVariable: values.tagVariable.trim(),
    preStartCommand: values.preStartCommand.trim() || null,
    healthUrl: values.healthUrl.trim() || null,
    backupBeforeDeploy: values.backupBeforeDeploy,
  };
}

function jarSettings(values: TargetValues) {
  return {
    ...commonSettings(values),
    jarName: values.jarName.trim(),
    systemdUnit: values.systemdUnit.trim(),
    healthUrl: values.healthUrl.trim() || null,
  };
}

/**
 * The API payload of a target's form values to update it: only the fields of
 * its kind (the API rejects the others), and never the kind itself.
 */
export function targetSettings(values: TargetValues) {
  if (values.kind === "static") return commonSettings(values);
  return values.kind === "jar" ? jarSettings(values) : composeSettings(values);
}

/** The API payload to create a target: its settings and its kind. */
export function newTargetInput(
  values: TargetValues,
  target: { environmentId: string; componentKey: string }
) {
  switch (values.kind) {
    case "jar":
      return { ...jarSettings(values), kind: "jar", ...target } as const;
    case "static":
      return { ...commonSettings(values), kind: "static", ...target } as const;
    default:
      return {
        ...composeSettings(values),
        kind: "compose",
        ...target,
      } as const;
  }
}

/**
 * The API's own target field schemas per kind, with the form's localized
 * messages. `extra` fields join every kind.
 */
export function useTargetSchema<S extends z.ZodRawShape>(extra?: S) {
  const t = useTranslations("deploys.form");
  const tCommon = useTranslations("common");
  const required = tCommon("required");
  const invalid = t("invalid");
  const matches = (schema: z.ZodType) => (value: string) =>
    schema.safeParse(value.trim()).success;
  const optional = (schema: z.ZodType) => (value: string) =>
    value.trim() === "" || schema.safeParse(value.trim()).success;
  const requiredText = (schema: z.ZodType) =>
    z.string().trim().min(1, required).refine(matches(schema), invalid);
  const common = {
    serverId: z.string().min(1, required),
    sourceBranch: requiredText(branchSchema),
    deployDir: requiredText(deployDirSchema),
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
    ...(extra ?? ({} as S)),
  };
  const healthUrl = z.string().refine(optional(healthUrlSchema), invalid);
  return z.discriminatedUnion("kind", [
    z.object({
      ...common,
      kind: z.literal("compose"),
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
      healthUrl,
      backupBeforeDeploy: z.boolean(),
    }),
    z.object({
      ...common,
      kind: z.literal("jar"),
      jarName: requiredText(jarNameSchema),
      systemdUnit: requiredText(systemdUnitSchema),
      healthUrl,
    }),
    z.object({ ...common, kind: z.literal("static") }),
  ]);
}

/**
 * Adds a deploy target. Existing targets are edited on the environment's
 * Settings → Source & Deploy tab. With an app on the environment the
 * component is picked from the app's components (the one not yet targeted
 * preselected when it is the only one; a hint instead when nothing is left
 * to pick, an error with Retry when the list fails to load); a legacy
 * environment without an app types the component key.
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
  const noticePipelineFailures = usePipelineFailureNotice();
  const appId = environment.appId ?? null;
  const fromApp = appId !== null;
  // Apps and their public components are listed for every signed-in user.
  const apps = useQuery({ ...listAppsQuery(), enabled: fromApp });
  const components =
    fromApp && apps.data
      ? (apps.data.find((app) => app.id === appId)?.components ?? [])
      : undefined;
  const taken = new Set(targetedKeys);
  const free = components?.filter((c) => !taken.has(c.componentKey)) ?? [];
  // Picking from the app: still loading, failed, or nothing left to pick.
  const loading = fromApp && apps.isPending;
  const failed = fromApp && !apps.data && apps.isError;
  const nothingToPick = components
    ? components.length === 0
      ? t("noComponents")
      : free.length === 0
        ? t("allComponentsTargeted")
        : null
    : null;
  const cannotAdd = loading || failed || nothingToPick !== null;

  const invalid = t("invalid");
  const schema = useTargetSchema({
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
    // The schema is one object per kind; the form values hold every field.
    resolver: zodResolver(schema) as unknown as Resolver<Values>,
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
      const created = await createDeployTarget(
        newTargetInput(values, {
          environmentId: environment.id,
          componentKey: values.componentKey.trim(),
        })
      );
      toast.success(t("created"));
      noticePipelineFailures(created.pipelineFileFailures);
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

  const kind = form.watch("kind");

  // `copy` is the message prefix of the label and hint, for a field whose
  // wording depends on the kind (the directory).
  const text = (
    name: Exclude<
      keyof Values,
      "serverId" | "kind" | "autoDeploy" | "backupBeforeDeploy"
    >,
    props: React.ComponentProps<typeof Input> = {},
    copy: string = name
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t(copy as "deployDir")}</FormLabel>
          <FormControl>
            <Input
              autoComplete="off"
              spellCheck={false}
              {...field}
              {...props}
            />
          </FormControl>
          <FormDescription>
            {t(`${copy}Hint` as "deployDirHint")}
          </FormDescription>
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
            {!fromApp ? (
              text("componentKey", { placeholder: "dplk-accounting" })
            ) : failed ? (
              <div className="flex flex-col items-start gap-2">
                <p role="alert" className="text-sm text-destructive">
                  {t("componentsLoadFailed")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void apps.refetch()}
                >
                  {t("componentsRetry")}
                </Button>
              </div>
            ) : nothingToPick ? (
              <p className="text-sm text-muted-foreground">{nothingToPick}</p>
            ) : (
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
                      disabled={loading}
                      items={Object.fromEntries(
                        (components ?? []).map((c) => [
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
                        {(components ?? []).map((c) => (
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
            )}
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("kind")}</FormLabel>
                  <RadioGroup
                    aria-label={t("kind")}
                    className="flex flex-wrap gap-4"
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value);
                      form.clearErrors();
                    }}
                  >
                    {TARGET_KINDS.map((option) => (
                      <label
                        key={option}
                        htmlFor={`target-kind-${option}`}
                        className="flex items-center gap-2 text-sm"
                      >
                        <RadioGroupItem
                          value={option}
                          id={`target-kind-${option}`}
                        />
                        {t(kindLabelKey(option))}
                      </label>
                    ))}
                  </RadioGroup>
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
            {text(
              "deployDir",
              {
                placeholder:
                  kind === "static" ? "/var/www/app" : "/opt/dplk-accounting",
              },
              deployDirCopy(kind)
            )}
            {kind === "compose" && (
              <>
                {text("services", { placeholder: "backend, frontend" })}
                {text("tagVariable")}
                {text("preStartCommand")}
              </>
            )}
            {kind === "jar" && (
              <>
                {text("jarName", { placeholder: "core-web-service.jar" })}
                {text("systemdUnit", { placeholder: "core-web" })}
              </>
            )}
            {kind !== "static" &&
              text("healthUrl", {
                inputMode: "url",
                placeholder: "http://localhost:8080/health",
              })}
            {text("healthTimeoutSeconds", { inputMode: "numeric" })}
            {toggle("autoDeploy")}
            {kind === "compose" && toggle("backupBeforeDeploy")}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {tCommon("cancel")}
              </Button>
              <Button
                type="submit"
                disabled={cannotAdd || form.formState.isSubmitting}
              >
                {t("create")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
