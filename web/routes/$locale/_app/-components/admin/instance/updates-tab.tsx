import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useFormatter, useNow, useTranslations } from "use-intl";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import {
  UPDATE_STATUS_CODES,
  UPDATE_STEPS,
  type UpdateStatusCode,
} from "@/lib/updates/request";
import { compareVersions, parseVersion } from "@/lib/version";
import {
  applyInstanceUpdate,
  checkInstanceUpdates,
  getInstanceUpdatesQuery,
  type InstanceUpdatesData,
  restoreSafetyBackup,
  saveInstanceUpdateSettings,
} from "@/web/api/instance";
import { refreshInstance, reportError } from "./report-error";
import { RestoreDialog } from "./restore-dialog";

type T = ReturnType<typeof useTranslations<"instanceUpdates">>;
type Status = NonNullable<InstanceUpdatesData["status"]>;

/** How often the tab re-reads the status while a run is underway. */
const POLL_MS = 2000;

export function updateStatusMessage(
  t: T,
  code: string,
  state?: Status["state"]
): string {
  // Failed (not rolled back) after an interruption: nothing says the Panel
  // is back on its version (a run cut off by a reboot, or older than the
  // updater's timeout).
  if (code === "interrupted" && state === "failed") {
    return t("interruptedFailed");
  }
  return (UPDATE_STATUS_CODES as readonly string[]).includes(code)
    ? t(`statusCodes.${code as UpdateStatusCode}`)
    : t("statusCodes.unknown", { code });
}

export function UpdatesTab() {
  const t = useTranslations("instanceUpdates");
  const data = useSuspenseQuery({
    ...getInstanceUpdatesQuery(),
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && (d.pending || d.status?.state === "running")
        ? POLL_MS
        : false;
    },
  }).data;

  return (
    <div className="flex flex-col gap-4">
      {!data.updaterInstalled && (
        <Alert>
          <TriangleAlert className="text-amber-600 dark:text-amber-500" />
          <AlertTitle>{t("updaterMissingTitle")}</AlertTitle>
          <AlertDescription>{t("updaterMissingDescription")}</AlertDescription>
        </Alert>
      )}
      <VersionCard data={data} />
      {(data.status || data.pending) && <StatusCard data={data} />}
      <SettingsCard data={data} />
    </div>
  );
}

function VersionCard({ data }: { data: InstanceUpdatesData }) {
  const t = useTranslations("instanceUpdates");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const tCommon = useTranslations("common");
  const [applying, setApplying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [checking, setChecking] = useState(false);
  const queryClient = useQueryClient();
  const { available } = data;
  const busy = data.pending || data.status?.state === "running";
  const tooOld =
    available !== null &&
    parseVersion(data.current) !== null &&
    compareVersions(data.current, available.minFrom) < 0;

  async function apply(version: string) {
    setConfirming(false);
    setApplying(true);
    try {
      await applyInstanceUpdate(version);
      toast.success(t("updateRequested"));
      // Picks up the pending request, which starts the live progress.
      await refreshInstance(queryClient);
    } catch (error) {
      reportError(error);
    } finally {
      setApplying(false);
    }
  }

  async function checkNow() {
    setChecking(true);
    try {
      queryClient.setQueryData(
        getInstanceUpdatesQuery().queryKey,
        await checkInstanceUpdates()
      );
    } catch (error) {
      reportError(error);
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("versionTitle")}</CardTitle>
        <CardDescription>
          {t("versionDescription", {
            version: data.current,
            channel:
              data.channel === "beta" ? t("channelBeta") : t("channelStable"),
          })}
        </CardDescription>
        {available && (
          <CardAction>
            <AlertDialog open={confirming} onOpenChange={setConfirming}>
              <AlertDialogTrigger
                render={
                  <Button
                    type="button"
                    disabled={
                      applying || busy || tooOld || !data.updaterInstalled
                    }
                  >
                    {applying ? (
                      <Loader2
                        data-icon="inline-start"
                        className="animate-spin"
                      />
                    ) : (
                      <Download data-icon="inline-start" />
                    )}
                    {t("update")}
                  </Button>
                }
              />
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("updateConfirmTitle", { version: available.version })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("updateConfirmBody")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => void apply(available.version)}
                  >
                    {t("update")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {available ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">
              {t("available", { version: available.version })}
            </span>
            <a
              href={available.notesUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
            >
              {t("releaseNotes")}
              <ExternalLink className="size-3.5" />
            </a>
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <CircleCheck className="size-4 text-success" />
            {t("upToDate")}
          </p>
        )}
        {available && tooOld && (
          <p className="text-sm text-destructive">
            {t("belowMinFrom", {
              version: available.version,
              minFrom: available.minFrom,
            })}
          </p>
        )}
        {available && data.autoUpdateSkipped && (
          <p className="text-sm text-muted-foreground">
            {t("autoUpdateSkipped", { version: available.version })}
          </p>
        )}
        {data.checkError && (
          <p className="flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-500">
            <CircleAlert className="size-4" />
            {t("checkFailed")}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            {data.checkedAt
              ? t("lastChecked", {
                  time: format.relativeTime(new Date(data.checkedAt), now),
                })
              : t("neverChecked")}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={checking}
            onClick={() => void checkNow()}
          >
            {checking ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            {t("checkNow")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** The steps shown for a run, in order; rollback only once it happens. */
function stepsOf(status: Status): (typeof UPDATE_STEPS)[number][] {
  return UPDATE_STEPS.filter(
    (s) =>
      (s !== "restore" || status.action === "restore") &&
      (s !== "rollback" ||
        status.step === "rollback" ||
        status.state === "rolled_back")
  );
}

function StepList({ status }: { status: Status }) {
  const t = useTranslations("instanceUpdates");
  const steps = stepsOf(status);
  const current = steps.indexOf(status.step);
  return (
    <ol
      className="flex flex-wrap gap-x-4 gap-y-2"
      aria-label={t("statusTitle")}
    >
      {steps.map((step, i) => {
        const done =
          status.state === "succeeded" ||
          i < current ||
          (step === "rollback" && status.state === "rolled_back");
        const active = i === current && status.state === "running";
        const failed =
          i === current &&
          status.state !== "running" &&
          status.state !== "succeeded" &&
          step !== "rollback";
        return (
          <li
            key={step}
            data-step={step}
            data-state={
              done ? "done" : active ? "active" : failed ? "failed" : "todo"
            }
            aria-current={active ? "step" : undefined}
            className={
              active || failed
                ? "flex items-center gap-1.5 text-sm font-medium"
                : "flex items-center gap-1.5 text-sm text-muted-foreground"
            }
          >
            {done ? (
              <CircleCheck className="size-4 text-success" />
            ) : active ? (
              <Loader2 className="size-4 animate-spin" />
            ) : failed ? (
              <CircleX className="size-4 text-destructive" />
            ) : (
              <CircleDashed className="size-4" />
            )}
            {t(`steps.${step}`)}
          </li>
        );
      })}
    </ol>
  );
}

function StatusCard({ data }: { data: InstanceUpdatesData }) {
  const t = useTranslations("instanceUpdates");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { status } = data;
  const title = !status
    ? t("statusTitle")
    : status.action === "update" && status.version
      ? t("runUpdate", { version: status.version })
      : status.action === "restore" && status.version
        ? t("runRestore", { version: status.version })
        : t("runUnknown");
  const variant =
    status?.state === "failed"
      ? "destructive"
      : status?.state === "running"
        ? "outline"
        : "secondary";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {status && (
          <CardDescription>
            {t("startedAt", {
              time: format.relativeTime(new Date(status.startedAt), now),
            })}
          </CardDescription>
        )}
        {status && (
          <CardAction>
            <Badge variant={variant}>{t(`states.${status.state}`)}</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data.pending && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("pending")}
          </p>
        )}
        {status && <StepList status={status} />}
        {status?.state === "rolled_back" &&
          (status.action === "restore" && status.restored ? (
            // The restore itself succeeded; only the update after it, to the
            // version that ran before, was rolled back.
            <Alert>
              <RotateCcw />
              <AlertTitle>{t("restoredRolledBackTitle")}</AlertTitle>
              <AlertDescription>
                {t("restoredRolledBack", { version: status.version ?? "" })}
              </AlertDescription>
            </Alert>
          ) : (
            <Alert>
              <RotateCcw />
              <AlertTitle>{t("rolledBackTitle")}</AlertTitle>
              <AlertDescription>
                {status.code ? updateStatusMessage(t, status.code) : null}
              </AlertDescription>
            </Alert>
          ))}
        {status &&
          status.state !== "rolled_back" &&
          status.state !== "running" &&
          status.code && (
            <Alert
              variant={status.state === "failed" ? "destructive" : "default"}
            >
              <CircleAlert />
              <AlertTitle>{t(`states.${status.state}`)}</AlertTitle>
              <AlertDescription>
                {updateStatusMessage(t, status.code, status.state)}
              </AlertDescription>
            </Alert>
          )}
        {status?.state === "failed" &&
          status.code === "restoreFailed" &&
          status.safetyBackup && (
            <Alert>
              <RotateCcw />
              <AlertTitle>{t("safetyTitle")}</AlertTitle>
              <AlertDescription>
                {t("safetyDescription")}
                <div className="mt-3">
                  <RestoreDialog
                    instance={data.instance}
                    version={status.from ?? ""}
                    disabled={!data.updaterInstalled || data.pending}
                    triggerLabel={t("restoreSafety")}
                    onConfirm={(confirm) => restoreSafetyBackup(confirm)}
                  />
                </div>
              </AlertDescription>
            </Alert>
          )}
        {status && status.logTail.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {t("log")}
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
              {status.logTail.join("\n")}
            </pre>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function SettingsCard({ data }: { data: InstanceUpdatesData }) {
  const t = useTranslations("instanceUpdates");
  const queryClient = useQueryClient();
  const tCommon = useTranslations("common");
  const schema = z.object({
    channel: z.enum(["stable", "beta"]),
    autoUpdate: z.boolean(),
    window: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, t("invalidTime")),
  });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      channel: data.channel,
      autoUpdate: data.autoUpdate,
      window: data.window,
    },
  });
  const loading = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !loading);

  async function onSubmit(values: Values) {
    try {
      await saveInstanceUpdateSettings(values);
    } catch (error) {
      reportError(error);
      return;
    }
    toast.success(t("saved"));
    form.reset(values);
    await refreshInstance(queryClient);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settingsTitle")}</CardTitle>
        <CardDescription>{t("settingsDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex max-w-2xl flex-col gap-4"
          >
            <FormField
              control={form.control}
              name="channel"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("channel")}</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) =>
                      field.onChange(value ?? data.channel)
                    }
                  >
                    <FormControl>
                      <SelectTrigger className="w-48">
                        <SelectValue>
                          {(value: string) =>
                            value === "beta"
                              ? t("channelBeta")
                              : t("channelStable")
                          }
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="stable">
                        {t("channelStable")}
                      </SelectItem>
                      <SelectItem value="beta">{t("channelBeta")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>{t("channelDescription")}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="autoUpdate"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center gap-2">
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <FormLabel className="font-normal">
                      {t("autoUpdate")}
                    </FormLabel>
                  </div>
                  <FormDescription>
                    {t("autoUpdateDescription")}
                  </FormDescription>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="window"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("window")}</FormLabel>
                  <FormControl>
                    <Input type="time" className="w-32" {...field} />
                  </FormControl>
                  <FormDescription>
                    {t("windowDescription", { zone: data.timeZone })}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => form.reset()}
                disabled={loading || !form.formState.isDirty}
              >
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={loading}>
                {loading && (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                )}
                {tCommon("save")}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
