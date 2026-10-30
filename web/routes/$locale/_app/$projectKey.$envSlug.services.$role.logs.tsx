import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import {
  getService,
  LOG_LINE_OPTIONS,
  type LogLines,
  type ServiceRole,
} from "@/lib/services";
import { getEnvironmentByIdQuery } from "@/web/api/environments";
import { loaderQuery } from "@/web/query-client";
import {
  type InitialLogState,
  LogsClient,
} from "./-components/env/logs-client";
import { LogsPending } from "./-components/env/skeletons";

const VALID_ROLES = ["db", "backend", "frontend"] as const;

const ROLE_TITLE_KEY = {
  db: "database",
  backend: "backend",
  frontend: "frontend",
} as const;

type LogsSearch = {
  tail?: string;
  q?: string;
  level?: string;
  view?: string;
};

function first(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value : undefined;
}

function parseTail(raw: string | undefined): LogLines {
  const n = Number(raw);
  return (LOG_LINE_OPTIONS as readonly number[]).includes(n)
    ? (n as LogLines)
    : 200;
}

function parseLevel(raw: string | undefined): InitialLogState["level"] {
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug") {
    return raw;
  }
  return "all";
}

export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/services/$role/logs"
)({
  validateSearch: (search: Record<string, unknown>): LogsSearch => ({
    tail: first(search.tail),
    q: first(search.q),
    level: first(search.level),
    view: first(search.view),
  }),
  beforeLoad: ({ params: { role } }) => {
    if (!VALID_ROLES.includes(role as ServiceRole)) throw notFound();
  },
  loader: async ({ context: { queryClient, environmentId } }) => {
    await loaderQuery(queryClient, getEnvironmentByIdQuery(environmentId));
  },
  pendingComponent: LogsPending,
  component: LogsPage,
});

function LogsPage() {
  const { projectKey, envSlug, role } = Route.useParams();
  const search = Route.useSearch();
  const { environmentId } = Route.useRouteContext();
  const t = useTranslations("services");
  const tDash = useTranslations("dashboard");
  const tCommon = useTranslations("common");
  const environment = useSuspenseQuery(
    getEnvironmentByIdQuery(environmentId)
  ).data;

  // The viewer's state is mirrored into the URL, which changes `search`; the
  // viewer only reads its initial state, so pin it to the first one.
  const initial = React.useRef<InitialLogState>({
    tail: parseTail(search.tail),
    q: search.q ?? "",
    level: parseLevel(search.level),
    view: search.view === "raw" ? "raw" : "pretty",
  }).current;

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  const typedRole = role as ServiceRole;
  const service = getService(environment, typedRole);
  const serviceName = service.serviceName;
  const serverName = service.server.name;
  const target = tDash(ROLE_TITLE_KEY[typedRole]);

  // Lock this page to the viewport so the log box scrolls internally instead
  // of scrolling the whole page. The surrounding <main> grows with its content
  // (body-scroll model), so the cap has to be explicit: subtract the sticky
  // header (h-14 = 3.5rem) and main's vertical padding (py-6 = 3rem). Inside,
  // the header is auto-height and the viewer takes the rest via flex-1.
  return (
    <div className="flex h-[calc(100svh-6.5rem)] min-h-0 flex-col gap-6">
      <PageHeader
        title={t("logs.title", { target })}
        subtitle={t("logs.pageSubtitle", { serviceName, serverName })}
        action={
          <Button
            render={<Link href={`/${projectKey}/${envSlug}/services`} />}
            nativeButton={false}
            variant="outline"
          >
            <ArrowLeft className="size-4" />
            {t("logs.backToServices")}
          </Button>
        }
      />
      <LogsClient
        environment={environment}
        role={typedRole}
        serviceName={serviceName}
        initial={initial}
      />
    </div>
  );
}
