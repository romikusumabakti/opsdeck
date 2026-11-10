import { useTranslations } from "use-intl";
import { AdvancedOptions } from "@/components/advanced-options";
import { EnvironmentDomainForm } from "@/components/environment-domain-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { canOrg } from "@/lib/permissions";
import type { EnvironmentDomain } from "@/web/api/environment-domains";
import { useMe } from "@/web/api/session";
import { AdoptDomainForm } from "./adopt-domain-form";

/**
 * The environment's address: subdomain and access policy, or none. Admins
 * may instead adopt a hostname Cloudflare already routes, while there is no
 * domain yet.
 */
export function DomainTab({
  environmentId,
  domain,
}: {
  environmentId: string;
  domain: EnvironmentDomain;
}) {
  const t = useTranslations("domains");
  const canAdopt = canOrg(useMe()?.orgRole, { server: ["manage"] });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <EnvironmentDomainForm
          // A fresh form once the saved binding changes.
          key={JSON.stringify(domain)}
          environmentId={environmentId}
          data={domain}
        />
        {canAdopt && !domain.domain && (
          <AdvancedOptions label={t("adopt.title")}>
            <AdoptDomainForm environmentId={environmentId} />
          </AdvancedOptions>
        )}
      </CardContent>
    </Card>
  );
}
