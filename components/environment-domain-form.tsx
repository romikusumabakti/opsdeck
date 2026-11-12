import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { AdvancedOptions } from "@/components/advanced-options";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
    <form
      onSubmit={form.handleSubmit(onSubmit, (errors) => {
        // Show the advanced field a failed save points at.
        if (errors.zoneId || errors.entryPort || errors.hostname) {
          setAdvancedOpen(true);
        }
      })}
    >
      <FieldGroup>
        {provisioned && (
          <Alert>
            <AlertDescription>{t("provisionedNotice")}</AlertDescription>
          </Alert>
        )}

        <Controller
          name="kind"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="environment-domain-kind">
                {t("kind")}
              </FieldLabel>
              <Select
                value={field.value}
                onValueChange={(value) => {
                  field.onChange(value as Kind);
                  if (value === "external") setAdvancedOpen(true);
                }}
                disabled={provisioned}
              >
                <SelectTrigger
                  id="environment-domain-kind"
                  aria-invalid={fieldState.invalid}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(`kind_${k}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />

        {kind === "tunnel" && (
          <>
            {domain?.tunnelName && (
              <p className="text-sm text-muted-foreground">
                {t("tunnelInUse", { tunnel: domain.tunnelName })}
              </p>
            )}
            <Controller
              name="label"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="environment-domain-label">
                    {t("label")}
                  </FieldLabel>
                  <Input
                    autoComplete="off"
                    className="font-mono"
                    disabled={provisioned}
                    {...field}
                    id="environment-domain-label"
                    aria-invalid={fieldState.invalid}
                    onChange={(e) =>
                      field.onChange(e.target.value.toLowerCase())
                    }
                  />
                  <FieldDescription className="font-mono">
                    {label && zoneName
                      ? `${label}.${zoneName}`
                      : t("labelHint")}
                  </FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              name="accessPolicyId"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="environment-domain-access-policy-id">
                    {t("accessPolicy")}
                  </FieldLabel>
                  <Select
                    value={field.value || undefined}
                    onValueChange={(value) => field.onChange(value ?? "")}
                    disabled={provisioned}
                  >
                    <SelectTrigger
                      id="environment-domain-access-policy-id"
                      aria-invalid={fieldState.invalid}
                    >
                      <SelectValue
                        placeholder={
                          policies.isError
                            ? t("policiesFailed")
                            : t("policyPlaceholder")
                        }
                      />
                    </SelectTrigger>
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
                  <FieldDescription>
                    {canGoPublic
                      ? t("accessPolicyDescription")
                      : t("accessPolicyRequired")}
                  </FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <AdvancedOptions open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <Controller
                name="zoneId"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="environment-domain-zone-id">
                      {t("zone")}
                    </FieldLabel>
                    <Select
                      value={field.value || undefined}
                      onValueChange={(value) => field.onChange(value ?? "")}
                      disabled={provisioned || zones.length === 0}
                    >
                      <SelectTrigger
                        id="environment-domain-zone-id"
                        aria-invalid={fieldState.invalid}
                      >
                        <SelectValue
                          placeholder={
                            zones.length === 0
                              ? t("noZones")
                              : t("zonePlaceholder")
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {zones.map((zone) => (
                          <SelectItem key={zone.id} value={zone.id}>
                            {zone.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
              <Controller
                name="entryPort"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="environment-domain-entry-port">
                      {t("entryPort")}
                    </FieldLabel>
                    <Input
                      inputMode="numeric"
                      className="font-mono"
                      disabled={provisioned}
                      {...field}
                      id="environment-domain-entry-port"
                      aria-invalid={fieldState.invalid}
                    />
                    <FieldDescription>
                      {t("entryPortDescription")}
                    </FieldDescription>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
            </AdvancedOptions>
          </>
        )}

        {kind === "external" && (
          <AdvancedOptions open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <Controller
              name="hostname"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="environment-domain-hostname">
                    {t("hostname")}
                  </FieldLabel>
                  <Input
                    autoComplete="off"
                    className="font-mono"
                    placeholder="app.example.com"
                    {...field}
                    id="environment-domain-hostname"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>
                    {t("hostnameDescription")}
                  </FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
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
      </FieldGroup>
    </form>
  );
}
