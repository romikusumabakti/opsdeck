import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { useFormatter, useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DATE_TIME } from "@/lib/format-date";
import { formatBytes } from "@/lib/utils";
import { getServerPreflightQuery, runServerPreflight } from "@/web/api/servers";

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** Last preflight scan of a server, with a button to run a new one. */
export function PreflightCard({ serverId }: { serverId: string }) {
  const t = useTranslations("serverPreflight");
  const format = useFormatter();
  const queryClient = useQueryClient();
  const queryOptions = getServerPreflightQuery(serverId);
  const stored = useQuery(queryOptions).data;

  const run = useMutation({
    mutationFn: () => runServerPreflight(serverId),
    onSuccess: async () => {
      toast.success(t("done"));
      await queryClient.invalidateQueries({ queryKey: queryOptions.queryKey });
    },
    onError: (error) => toast.error(error.message || t("failed")),
  });

  const preflight = stored?.preflight ?? null;
  const notInstalled = t("notInstalled");

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="text-base">{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
          <p className="text-sm text-muted-foreground">
            {stored?.preflightAt
              ? t("lastRun", {
                  time: format.dateTime(
                    new Date(stored.preflightAt),
                    DATE_TIME
                  ),
                })
              : t("never")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          <Play className="size-4" />
          {run.isPending ? t("running") : t("run")}
        </Button>
      </CardHeader>
      {preflight ? (
        <CardContent>
          <dl className="flex flex-col gap-3 text-sm">
            <Row label={t("runtime")}>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span>
                  {t("docker")}: {preflight.runtime.docker ?? notInstalled}
                </span>
                <span>
                  {t("compose")}: {preflight.runtime.compose ?? notInstalled}
                </span>
                <span>
                  {t("podman")}: {preflight.runtime.podman ?? notInstalled}
                </span>
              </div>
            </Row>
            <Row label={t("registry")}>
              {preflight.registry ? (
                <Badge
                  variant={preflight.registry.ok ? "secondary" : "destructive"}
                >
                  {preflight.registry.ok
                    ? t("reachable", { status: preflight.registry.status ?? 0 })
                    : t("unreachable")}
                </Badge>
              ) : (
                t("notConfigured")
              )}
            </Row>
            <Row label={t("disk")}>
              <ul className="flex flex-col gap-1">
                {preflight.disk.map((d) => (
                  <li key={d.mount}>
                    <span className="font-mono">{d.mount}</span>{" "}
                    {t("diskFree", {
                      free: formatBytes(d.freeBytes),
                      total: formatBytes(d.totalBytes),
                    })}
                  </li>
                ))}
              </ul>
            </Row>
            <Row label={t("cloudflared")}>
              <div className="flex flex-col gap-1">
                <span>
                  {preflight.cloudflared.systemd
                    ? t("systemdActive")
                    : t("systemdInactive")}
                </span>
                {preflight.cloudflared.containers.length > 0 ? (
                  <span className="font-mono">
                    {t("containers", {
                      names: preflight.cloudflared.containers.join(", "),
                    })}
                  </span>
                ) : null}
              </div>
            </Row>
            <Row label={t("postgres")}>
              {preflight.postgresCandidates.length === 0 ? (
                t("postgresNone")
              ) : (
                <ul className="flex flex-col gap-1">
                  {preflight.postgresCandidates.map((c) => (
                    <li key={c.container} className="font-mono">
                      {c.container}{" "}
                      <span className="text-muted-foreground">{c.image}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Row>
          </dl>
        </CardContent>
      ) : null}
    </Card>
  );
}
