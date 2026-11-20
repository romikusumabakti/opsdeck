import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { SearchSelect } from "@/components/search-select";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DOMAIN_ERRORS, type DomainErrorCode } from "@/lib/domains/errors";
import { ingressServiceSchema, isFqdn } from "@/lib/domains/validation";
import { ApiError } from "@/web/api/client";
import { adoptEnvironmentDomain } from "@/web/api/environment-domains";
import { remoteTunnelsQuery } from "@/web/api/remote-tunnels";
import { useTeardownErrorText } from "../use-teardown-error-text";

const isDomainErrorCode = (code: string): code is DomainErrorCode =>
  Object.hasOwn(DOMAIN_ERRORS, code);

/**
 * Binds a hostname Cloudflare already routes through a registered tunnel
 * (org server:manage; shown only while the environment has no domain), so
 * Menara records it and a teardown removes it.
 */
export function AdoptDomainForm({ environmentId }: { environmentId: string }) {
  const t = useTranslations("domains");
  const tCommon = useTranslations("common");
  const teardownErrorText = useTeardownErrorText();
  const tunnels = useQuery(remoteTunnelsQuery()).data ?? [];

  const schema = z.object({
    hostname: z
      .string()
      .refine((v) => isFqdn(v.trim().toLowerCase()), t("hostnameInvalid")),
    remoteTunnelId: z.string().min(1, tCommon("required")),
    service: z
      .string()
      .refine(
        (v) => ingressServiceSchema.safeParse(v).success,
        t("adopt.serviceInvalid")
      ),
  });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { hostname: "", remoteTunnelId: "", service: "" },
  });

  function errorText(error: ApiError): string {
    if (error.code && isDomainErrorCode(error.code)) {
      return t(`errors.${error.code}`);
    }
    return teardownErrorText(error.code, t("adopt.failed"));
  }

  async function onSubmit(values: Values) {
    const hostname = values.hostname.trim().toLowerCase();
    try {
      await adoptEnvironmentDomain(environmentId, {
        hostname,
        remoteTunnelId: values.remoteTunnelId,
        service: values.service.trim(),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(errorText(error));
        return;
      }
      throw error;
    }
    toast.success(t("adopt.adopted", { hostname }));
  }

  const loading = form.formState.isSubmitting;

  return (
    <form
      onSubmit={form.handleSubmit(onSubmit)}
      className="flex flex-col gap-4"
    >
      <p className="text-sm text-muted-foreground">{t("adopt.description")}</p>
      <FieldGroup>
        <Controller
          name="hostname"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="adopt-domain-hostname">
                {t("adopt.hostname")}
              </FieldLabel>
              <Input
                autoComplete="off"
                className="font-mono"
                placeholder="app.example.com"
                {...field}
                id="adopt-domain-hostname"
                aria-invalid={fieldState.invalid}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="remoteTunnelId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="adopt-domain-tunnel">
                {t("adopt.tunnel")}
              </FieldLabel>
              <SearchSelect
                id="adopt-domain-tunnel"
                invalid={fieldState.invalid}
                value={field.value || null}
                onChange={(value) => field.onChange(value ?? "")}
                disabled={tunnels.length === 0}
                options={tunnels.map((tunnel) => ({
                  value: tunnel.id,
                  label: tunnel.name,
                  hint: tunnel.serverName,
                }))}
                placeholder={
                  tunnels.length === 0
                    ? t("adopt.noTunnels")
                    : t("adopt.tunnelPlaceholder")
                }
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="service"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="adopt-domain-service">
                {t("adopt.service")}
              </FieldLabel>
              <Input
                autoComplete="off"
                className="font-mono"
                placeholder="http://container:port"
                {...field}
                id="adopt-domain-service"
                aria-invalid={fieldState.invalid}
              />
              <FieldDescription>
                {t("adopt.serviceDescription")}
              </FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      </FieldGroup>
      <div className="flex justify-end">
        <Button type="submit" variant="outline" disabled={loading}>
          {loading ? t("adopt.adopting") : t("adopt.submit")}
        </Button>
      </div>
    </form>
  );
}
