import { useTranslations } from "use-intl";
import { EnvironmentDomainForm } from "@/components/environment-domain-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { EnvironmentDomain } from "@/web/api/environment-domains";

/** The environment's address: subdomain and access policy, or none. */
export function DomainTab({
  environmentId,
  domain,
}: {
  environmentId: string;
  domain: EnvironmentDomain;
}) {
  const t = useTranslations("domains");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <EnvironmentDomainForm
          // A fresh form once the saved binding changes.
          key={JSON.stringify(domain)}
          environmentId={environmentId}
          data={domain}
        />
      </CardContent>
    </Card>
  );
}
