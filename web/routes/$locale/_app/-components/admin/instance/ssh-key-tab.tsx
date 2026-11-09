import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { KeyRound, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import { useDialog } from "@/components/dialog-provider";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useKeyErrorMessage } from "@/hooks/use-key-error-message";
import {
  getInstanceSshKeyQuery,
  type InstanceSshKeyData,
  moveAllServersToKey,
  rotateInstanceSshKey,
} from "@/web/api/instance";
import { reportError } from "./report-error";

const POLL_MS = 2000;

/** How often to refetch: every POLL_MS while the last job runs, else never. */
export function keyJobPollInterval(
  data: Pick<InstanceSshKeyData, "lastJob"> | undefined
): number | false {
  const job = data?.lastJob;
  return job && job.finishedAt === null ? POLL_MS : false;
}

/**
 * Admin → Instance → SSH key: the instance public key and its fingerprint,
 * "Move all servers to the SSH key" and "Rotate", and the last of those jobs
 * server by server. Polls while a job runs. The routes need org
 * server:manage, which every role with instance:manage has.
 */
export function SshKeyTab() {
  const t = useTranslations("instanceSshKey");
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const data = useSuspenseQuery({
    ...getInstanceSshKeyQuery(),
    refetchInterval: (query) => keyJobPollInterval(query.state.data),
  }).data;
  const [requesting, setRequesting] = useState(false);
  const running = data.lastJob !== null && data.lastJob.finishedAt === null;
  // A job that just finished changed servers' sign-in: the Servers list
  // refetches instead of showing the old Access badges.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
    }
    wasRunning.current = running;
  }, [running, queryClient]);

  async function start(
    confirm: { title: string; description: string; confirmText: string },
    request: () => Promise<unknown>
  ) {
    const ok = await dialog.confirm(confirm);
    if (!ok) return;
    setRequesting(true);
    try {
      await request();
      toast.success(t("started"));
    } catch (error) {
      reportError(error);
    } finally {
      setRequesting(false);
      await queryClient.invalidateQueries({
        queryKey: getInstanceSshKeyQuery().queryKey,
      });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">{t("title")}</CardTitle>
          </div>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t("publicKey")}</dt>
            <dd className="flex min-w-0 items-start gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-xs">
                {data.publicKey}
              </code>
              <CopyButton value={data.publicKey} />
            </dd>
            <dt className="text-muted-foreground">{t("fingerprint")}</dt>
            <dd className="font-mono text-xs break-all">{data.fingerprint}</dd>
          </dl>
          {data.previous ? (
            <p className="text-sm text-amber-700 dark:text-amber-500">
              {t("previousKey", { fingerprint: data.previous.fingerprint })}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={running || requesting}
              onClick={() =>
                void start(
                  {
                    title: t("moveAllTitle"),
                    description: t("moveAllDescription"),
                    confirmText: t("moveAll"),
                  },
                  moveAllServersToKey
                )
              }
            >
              {t("moveAll")}
            </Button>
            <Button
              variant="outline"
              disabled={running || requesting}
              onClick={() =>
                void start(
                  {
                    title: t("rotateTitle"),
                    description: t("rotateDescription"),
                    confirmText: t("rotate"),
                  },
                  rotateInstanceSshKey
                )
              }
            >
              {t("rotate")}
            </Button>
          </div>
        </CardContent>
      </Card>
      {data.lastJob ? <JobCard job={data.lastJob} /> : null}
    </div>
  );
}

function JobCard({ job }: { job: NonNullable<InstanceSshKeyData["lastJob"]> }) {
  const t = useTranslations("instanceSshKey");
  const message = useKeyErrorMessage();
  const running = job.finishedAt === null;
  const count = job.results.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {job.kind === "moveAll" ? t("lastMoveAll") : t("lastRotate")}
        </CardTitle>
        <CardDescription>
          {running ? (
            <span
              aria-live="polite"
              className="inline-flex items-center gap-1.5"
            >
              <Loader2 className="size-4 animate-spin" />
              {job.kind === "moveAll"
                ? t("runningMoveAll", { count })
                : t("runningRotate", { count })}
            </span>
          ) : (
            <RelativeTime date={job.finishedAt ?? job.requestedAt} />
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {job.errorCode ? (
          <p className="text-sm text-destructive">{message(job.errorCode)}</p>
        ) : null}
        {count === 0 ? (
          running ? null : (
            <p className="text-sm text-muted-foreground">{t("noServers")}</p>
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colServer")}</TableHead>
                <TableHead>{t("colResult")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {job.results.map((result) => (
                <TableRow key={result.serverId}>
                  <TableCell className="font-medium">{result.name}</TableCell>
                  <TableCell className="whitespace-normal">
                    {result.ok ? (
                      <Badge variant="secondary">{t("ok")}</Badge>
                    ) : (
                      <span className="flex flex-col gap-1">
                        <Badge variant="destructive">{t("failed")}</Badge>
                        {result.code ? (
                          <span className="text-sm text-muted-foreground">
                            {message(result.code)}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
