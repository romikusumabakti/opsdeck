import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { AdvancedOptions } from "@/components/advanced-options";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { domainErrorCode } from "@/lib/domains/errors";
import { DOMAIN_LABEL_PATTERN, isFqdn } from "@/lib/domains/validation";
import { canOrg } from "@/lib/permissions";
import { ApiError } from "@/web/api/client";
import {
  deleteEnvironmentDomain,
  domainAccessPoliciesQuery,
  type EnvironmentDomain,
  putEnvironmentDomain,
} from "@/web/api/environment-domains";
import { useMe } from "@/web/api/session";

const PUBLIC = "__public";
const KINDS = ["none", "tunnel", "external"] as const;

type Kind = (typeof KINDS)[number];

const CHECKLIST = ["checkDns", "checkProxy", "checkCertificate"] as const;

export function EnvironmentDomainForm({
  environmentId,
  data,
}: {
  environmentId: string;
  data: EnvironmentDomain;
}) {
  const t = useTranslations("domains");
  const tCommon = useTranslations("common");
  const me = useMe();
  const canGoPublic = canOrg(me?.orgRole, { server: ["manage"] });
  const { domain, zones } = data;
  const provisioned = domain?.provisioned === true;

  const schema = z
    .object({
      kind: z.enum(KINDS),
      zoneId: z.string(),
      label: z.string(),
      entryPort: z.string(),
      accessPolicyId: z.string(),
      hostname: z.string(),
    })
    .superRefine((v, ctx) => {
      const issue = (path: keyof typeof v, message: string) =>
        ctx.addIssue({ code: "custom", path: [path], message });
      if (v.kind === "tunnel") {
        if (!v.zoneId) issue("zoneId", tCommon("required"));
        if (!DOMAIN_LABEL_PATTERN.test(v.label)) {
          issue("label", t("labelInvalid"));
        }
        const port = Number(v.entryPort);
        if (!(Number.isInteger(port) && port >= 1 && port <= 65_535)) {
          issue("entryPort", t("portInvalid"));
        }
        if (!v.accessPolicyId) issue("accessPolicyId", tCommon("required"));
      }
      if (v.kind === "external" && !isFqdn(v.hostname.trim().toLowerCase())) {
        issue("hostname", t("hostnameInvalid"));
      }
    });
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      kind: domain?.kind ?? "none",
      zoneId: domain?.zoneId ?? zones[0]?.id ?? "",
      label: domain?.label ?? "",
      entryPort: data.entryPort ? String(data.entryPort) : "",
      accessPolicyId:
        domain?.kind === "tunnel" ? (domain.accessPolicyId ?? PUBLIC) : "",
      hostname: domain?.kind === "external" ? domain.hostname : "",
    },
  });

  const kind = useWatch({ control: form.control, name: "kind" });
  // Zone, entry port and the external hostname are advanced options; an
  // external domain has no other field, so it opens them.
  const [advancedOpen, setAdvancedOpen] = useState(domain?.kind === "external");
  const label = useWatch({ control: form.control, name: "label" });
  const zoneId = useWatch({ control: form.control, name: "zoneId" });
  const zoneName = zones.find((z) => z.id === zoneId)?.name;

  const policies = useQuery({
    ...domainAccessPoliciesQuery(environmentId),
    enabled: kind === "tunnel" && !provisioned,
    retry: false,
  });

  function errorText(error: ApiError): string {
    const code = domainErrorCode(error.message);
    return code ? t(`errors.${code}`) : error.message;
  }

  async function onSubmit(values: Values) {
    try {
      if (values.kind === "none") {
        if (domain) await deleteEnvironmentDomain(environmentId);
      } else if (values.kind === "external") {
        await putEnvironmentDomain(environmentId, {
          kind: "external",
          hostname: values.hostname.trim().toLowerCase(),
        });
      } else {
        await putEnvironmentDomain(environmentId, {
          kind: "tunnel",
          zoneId: values.zoneId,
          label: values.label,
          accessPolicyId:
            values.accessPolicyId === PUBLIC ? null : values.accessPolicyId,
          entryPort: Number(values.entryPort),
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(errorText(error));
        return;
      }
      throw error;
    }
    toast.success(t("saved"));
    form.reset(values);
  }

  const loading = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !loading);

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit, (errors) => {
          // Show the advanced field a failed save points at.
          if (errors.zoneId || errors.entryPort || errors.hostname) {
            setAdvancedOpen(true);
          }
        })}
        className="flex flex-col gap-4"
      >
        {provisioned && (
          <Alert>
            <AlertDescription>{t("provisionedNotice")}</AlertDescription>
          </Alert>
        )}

        <FormField
          control={form.control}
          name="kind"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("kind")}</FormLabel>
              <Select
                value={field.value}
                onValueChange={(value) => {
                  field.onChange(value as Kind);
                  if (value === "external") setAdvancedOpen(true);
                }}
                disabled={provisioned}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(`kind_${k}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {kind === "tunnel" && (
          <>
            {domain?.tunnelName && (
              <p className="text-sm text-muted-foreground">
                {t("tunnelInUse", { tunnel: domain.tunnelName })}
              </p>
            )}
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("label")}</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="off"
                      className="font-mono"
                      disabled={provisioned}
                      {...field}
                      onChange={(e) =>
                        field.onChange(e.target.value.toLowerCase())
                      }
                    />
                  </FormControl>
                  <FormDescription className="font-mono">
                    {label && zoneName
                      ? `${label}.${zoneName}`
                      : t("labelHint")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="accessPolicyId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("accessPolicy")}</FormLabel>
                  <Select
                    value={field.value || undefined}
                    onValueChange={(value) => field.onChange(value ?? "")}
                    disabled={provisioned}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue
                          placeholder={
                            policies.isError
                              ? t("policiesFailed")
                              : t("policyPlaceholder")
                          }
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {canGoPublic && (
                        <SelectItem value={PUBLIC}>{t("public")}</SelectItem>
                      )}
                      {policies.data?.map((policy) => (
                        <SelectItem key={policy.id} value={policy.id}>
                          {policy.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {policies.error instanceof ApiError && (
                    <p className="text-sm text-destructive">
                      {errorText(policies.error)}
                    </p>
                  )}
                  <FormDescription>
                    {canGoPublic
                      ? t("accessPolicyDescription")
                      : t("accessPolicyRequired")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <AdvancedOptions open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <FormField
                control={form.control}
                name="zoneId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("zone")}</FormLabel>
                    <Select
                      value={field.value || undefined}
                      onValueChange={(value) => field.onChange(value ?? "")}
                      disabled={provisioned || zones.length === 0}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue
                            placeholder={
                              zones.length === 0
                                ? t("noZones")
                                : t("zonePlaceholder")
                            }
                          />
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
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="entryPort"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("entryPort")}</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="numeric"
                        className="font-mono"
                        disabled={provisioned}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      {t("entryPortDescription")}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </AdvancedOptions>
          </>
        )}

        {kind === "external" && (
          <AdvancedOptions open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <FormField
              control={form.control}
              name="hostname"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("hostname")}</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="off"
                      className="font-mono"
                      placeholder="app.example.com"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>{t("hostnameDescription")}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="text-sm">
              <p className="font-medium">{t("checklistTitle")}</p>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                {CHECKLIST.map((item) => (
                  <li key={item}>{t(item)}</li>
                ))}
              </ul>
            </div>
          </AdvancedOptions>
        )}

        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={loading || provisioned}>
            {loading ? t("saving") : t("save")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
