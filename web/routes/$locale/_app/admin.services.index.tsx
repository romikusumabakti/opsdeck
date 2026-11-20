import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Boxes, Plus, Search } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FacetedFilter } from "@/components/ui/faceted-filter";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import {
  listServicesOverviewQuery,
  type ServiceOverviewRow,
} from "@/web/api/service-catalog";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { ListPending } from "./-components/list-pending";
import { RegisterServicesDialog } from "./-components/services/register-services-dialog";

/** `?repo=` once or repeated: the repositories the list is filtered to. */
export function servicesSearch(search: Record<string, unknown>): {
  repo?: string[];
} {
  const raw = search.repo;
  const repos = (Array.isArray(raw) ? raw : [raw]).filter(
    (r): r is string => typeof r === "string" && r !== ""
  );
  return repos.length > 0 ? { repo: repos } : {};
}

/** The rows matching the search text (key or repository) and repositories. */
export function filterServices<S extends { key: string; repoFullName: string }>(
  services: readonly S[],
  query: string,
  repos: readonly string[]
): S[] {
  const q = query.trim().toLowerCase();
  return services.filter(
    (s) =>
      (repos.length === 0 || repos.includes(s.repoFullName)) &&
      (q === "" ||
        s.key.toLowerCase().includes(q) ||
        s.repoFullName.toLowerCase().includes(q))
  );
}

// The services Menara builds and deploys (Stage 8: a service is one
// buildable unit of a repository), under admin: org integration:manage, like
// the pipeline actions and variable templates on a service's page.
export const Route = createFileRoute("/$locale/_app/admin/services/")({
  validateSearch: servicesSearch,
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { integration: ["manage"] });
  },
  loader: async ({ context: { queryClient } }) => {
    await loaderQuery(queryClient, listServicesOverviewQuery());
  },
  pendingComponent: () => <ListPending columns={5} />,
  component: ServicesPage,
});

function ServicesPage() {
  const t = useTranslations("serviceCatalog");
  const services = useSuspenseQuery(listServicesOverviewQuery()).data;
  const { repo = [] } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [query, setQuery] = React.useState("");
  const [registering, setRegistering] = React.useState(false);
  const visible = filterServices(services, query, repo);
  const repoOptions = [
    ...new Set([...services.map((s) => s.repoFullName), ...repo]),
  ]
    .sort()
    .map((r) => ({ value: r, label: r }));

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <Button onClick={() => setRegistering(true)}>
            <Plus data-icon="inline-start" />
            {t("register")}
          </Button>
        }
      />
      {services.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={Boxes}
            title={t("emptyTitle")}
            description={t("empty")}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative max-w-sm flex-1">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("search")}
                aria-label={t("search")}
                className="ps-8"
              />
            </div>
            <FacetedFilter
              title={t("colRepo")}
              options={repoOptions}
              selected={repo}
              onChange={(next) =>
                void navigate({
                  search: next.length > 0 ? { repo: next } : {},
                  replace: true,
                })
              }
            />
          </div>
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colService")}</TableHead>
                  <TableHead>{t("colRepo")}</TableHead>
                  <TableHead>{t("colCi")}</TableHead>
                  <TableHead>{t("colLastBuild")}</TableHead>
                  <TableHead>{t("colUsedBy")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-sm text-muted-foreground"
                    >
                      {t("noMatches")}
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((service) => (
                    <ServiceListRow key={service.key} service={service} />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      <RegisterServicesDialog
        open={registering}
        onOpenChange={setRegistering}
      />
    </>
  );
}

function ServiceListRow({ service }: { service: ServiceOverviewRow }) {
  const t = useTranslations("serviceCatalog");
  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/admin/services/${encodeURIComponent(service.key)}`}
            className="font-mono font-medium hover:underline"
          >
            {service.key}
          </Link>
          <Badge variant="outline">
            {service.pipelineMode === "generated"
              ? t("modeGenerated")
              : t("modeCustom")}
          </Badge>
        </div>
      </TableCell>
      <TableCell className="font-mono text-sm">
        {service.repoFullName}
      </TableCell>
      <TableCell className="text-sm">
        {service.ciConnectionName ?? "—"}
      </TableCell>
      <TableCell className="text-sm">
        {service.lastBuild ? (
          <div className="flex flex-col">
            <span className="font-mono">{service.lastBuild.tag}</span>
            <span className="text-xs text-muted-foreground">
              {service.lastBuild.branch} ·{" "}
              <RelativeTime date={service.lastBuild.receivedAt} />
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">{t("noBuild")}</span>
        )}
      </TableCell>
      <TableCell className="text-sm">
        {t("usedBy", {
          projects: service.projectCount,
          environments: service.environmentCount,
        })}
      </TableCell>
    </TableRow>
  );
}
