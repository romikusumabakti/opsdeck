import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
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
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="accountId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("accountId")}</FormLabel>
              <FormControl>
                <Input autoComplete="off" className="font-mono" {...field} />
              </FormControl>
              <FormDescription>{t("accountIdDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="apiToken"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center gap-2">
                <FormLabel>{t("apiToken")}</FormLabel>
                <Badge variant={account?.hasToken ? "secondary" : "outline"}>
                  {account?.hasToken ? t("set") : t("notSet")}
                </Badge>
              </div>
              <FormControl>
                <PasswordInput
                  autoComplete="new-password"
                  placeholder={
                    account?.hasToken ? t("keepPlaceholder") : undefined
                  }
                  {...field}
                />
              </FormControl>
              <FormDescription>{t("apiTokenDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="accessIdpId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("accessIdp")}</FormLabel>
              <Select
                value={field.value || undefined}
                onValueChange={(value) => field.onChange(value ?? "")}
                disabled={!idps.data}
              >
                <FormControl>
                  <SelectTrigger>
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
                </FormControl>
                <SelectContent>
                  {idps.data?.map((idp) => (
                    <SelectItem key={idp.id} value={idp.id}>
                      {idp.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>{t("accessIdpDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
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
      </form>
    </Form>
  );
}
