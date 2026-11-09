import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
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
import { DOMAIN_ERRORS, type DomainErrorCode } from "@/lib/domains/errors";
import { ingressServiceSchema, isFqdn } from "@/lib/domains/validation";
import { ApiError } from "@/web/api/client";
import { adoptEnvironmentDomain } from "@/web/api/environment-domains";
import { remoteTunnelsQuery } from "@/web/api/remote-tunnels";
import { useTeardownErrorText } from "../teardown-banner";

const isDomainErrorCode = (code: string): code is DomainErrorCode =>
  Object.hasOwn(DOMAIN_ERRORS, code);

/**
 * Binds a hostname Cloudflare already routes through a registered tunnel
 * (org server:manage; shown only while the environment has no domain), so
 * the Panel records it and a teardown removes it.
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
    return teardownErrorText(error.code, error.message);
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
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-4"
      >
        <p className="text-sm text-muted-foreground">
          {t("adopt.description")}
        </p>
        <FormField
          control={form.control}
          name="hostname"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("adopt.hostname")}</FormLabel>
              <FormControl>
                <Input
                  autoComplete="off"
                  className="font-mono"
                  placeholder="app.example.com"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="remoteTunnelId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("adopt.tunnel")}</FormLabel>
              <Select
                value={field.value || undefined}
                onValueChange={(value) => field.onChange(value ?? "")}
                disabled={tunnels.length === 0}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        tunnels.length === 0
                          ? t("adopt.noTunnels")
                          : t("adopt.tunnelPlaceholder")
                      }
                    />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {tunnels.map((tunnel) => (
                    <SelectItem key={tunnel.id} value={tunnel.id}>
                      {tunnel.name} · {tunnel.serverName}
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
          name="service"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("adopt.service")}</FormLabel>
              <FormControl>
                <Input
                  autoComplete="off"
                  className="font-mono"
                  placeholder="http://container:port"
                  {...field}
                />
              </FormControl>
              <FormDescription>{t("adopt.serviceDescription")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex justify-end">
          <Button type="submit" variant="outline" disabled={loading}>
            {loading ? t("adopt.adopting") : t("adopt.submit")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
