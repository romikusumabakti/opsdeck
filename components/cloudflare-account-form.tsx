import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { ApiError } from "@/web/api/client";
import {
  type CloudflareAccountRow,
  cloudflareIdentityProvidersQuery,
  saveCloudflareAccount,
  verifyCloudflareAccount,
} from "@/web/api/cloudflare-account";

export function CloudflareAccountForm({
  account,
}: {
  account: CloudflareAccountRow | null;
}) {
  const t = useTranslations("cloudflareAccount");
  const tCommon = useTranslations("common");
  const [verifying, setVerifying] = useState(false);

  const schema = z.object({
    accountId: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{32}$/, t("accountIdInvalid")),
    name: z.string().trim().min(1, tCommon("required")),
    // Blank keeps the stored token (required only for the first save).
    apiToken: z.string(),
    accessIdpId: z.string(),
  });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      accountId: account?.accountId ?? "",
      name: account?.name ?? "",
      apiToken: "",
      accessIdpId: account?.accessIdpId ?? "",
    },
  });

  // The IdP list needs a saved token, so it loads only after the first save.
  const idps = useQuery({
    ...cloudflareIdentityProvidersQuery(),
    enabled: !!account?.hasToken,
  });

  async function onSubmit(values: z.infer<typeof schema>) {
    if (!(account || values.apiToken.trim())) {
      form.setError("apiToken", { message: tCommon("required") });
      return;
    }
    try {
      await saveCloudflareAccount({
        accountId: values.accountId.trim(),
        name: values.name.trim(),
        ...(values.apiToken.trim() && { apiToken: values.apiToken.trim() }),
        accessIdpId: values.accessIdpId || null,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(error.message);
        return;
      }
      throw error;
    }
    toast.success(t("saved"));
    form.reset({ ...values, apiToken: "" });
  }

  async function onVerify() {
    setVerifying(true);
    try {
      const { tunnels } = await verifyCloudflareAccount();
      toast.success(t("verified", { count: tunnels }));
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(error.message);
        return;
      }
      throw error;
    } finally {
      setVerifying(false);
    }
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
              <FieldLabel htmlFor="cloudflare-account-name">
                {t("name")}
              </FieldLabel>
              <Input
                {...field}
                id="cloudflare-account-name"
                aria-invalid={fieldState.invalid}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="accountId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="cloudflare-account-account-id">
                {t("accountId")}
              </FieldLabel>
              <Input
                autoComplete="off"
                className="font-mono"
                {...field}
                id="cloudflare-account-account-id"
                aria-invalid={fieldState.invalid}
              />
              <FieldDescription>{t("accountIdDescription")}</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="apiToken"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <div className="flex items-center gap-2">
                <FieldLabel htmlFor="cloudflare-account-api-token">
                  {t("apiToken")}
                </FieldLabel>
                <Badge variant={account?.hasToken ? "secondary" : "outline"}>
                  {account?.hasToken ? t("set") : t("notSet")}
                </Badge>
              </div>
              <PasswordInput
                autoComplete="new-password"
                placeholder={
                  account?.hasToken ? t("keepPlaceholder") : undefined
                }
                {...field}
                id="cloudflare-account-api-token"
                aria-invalid={fieldState.invalid}
              />
              <FieldDescription>{t("apiTokenDescription")}</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="accessIdpId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="cloudflare-account-access-idp-id">
                {t("accessIdp")}
              </FieldLabel>
              <Select
                value={field.value || undefined}
                onValueChange={(value) => field.onChange(value ?? "")}
                disabled={!idps.data}
              >
                <SelectTrigger
                  id="cloudflare-account-access-idp-id"
                  aria-invalid={fieldState.invalid}
                >
                  <SelectValue
                    placeholder={
                      account?.hasToken
                        ? idps.isError
                          ? t("idpLoadFailed")
                          : t("idpPlaceholder")
                        : t("idpAfterSave")
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {idps.data?.map((idp) => (
                    <SelectItem key={idp.id} value={idp.id}>
                      {idp.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{t("accessIdpDescription")}</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />

        <div className="flex justify-end gap-2 pt-2">
          {account?.hasToken && (
            <Button
              type="button"
              variant="outline"
              onClick={onVerify}
              disabled={verifying || loading}
            >
              {verifying ? t("verifying") : t("verify")}
            </Button>
          )}
          <Button type="submit" disabled={loading}>
            {loading ? t("submitting") : t("save")}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
