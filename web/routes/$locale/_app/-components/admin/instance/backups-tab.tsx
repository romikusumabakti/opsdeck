import { zodResolver } from "@hookform/resolvers/zod";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  Check,
  CircleCheck,
  CircleX,
  DatabaseBackup,
  KeyRound,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { EmptyState } from "@/components/ui/empty-state";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { formatBytes } from "@/lib/utils";
import {
  acknowledgeInstanceBackup,
  getInstanceBackupsQuery,
  type InstanceBackupRow,
  type InstanceBackupsData,
  restoreInstanceBackup,
  runInstanceBackupNow,
  saveInstanceBackupSettings,
  verifySecretsKey,
} from "@/web/api/instance";
import { reportError } from "./report-error";
import { RestoreDialog } from "./restore-dialog";

// The Select's value for "no destination" (Base UI items need a string).
const LOCAL = "local";

// Every code runInstanceBackup can record (lib/instance-backup/archive).
const ERROR_CODES = [
  "backupSecretsKeyMissing",
  "backupDestinationFailed",
  "backupDumpFailed",
  "backupGarageFailed",
  "backupWriteFailed",
  "backupUploadFailed",
  "backupRecordFailed",
  "backupInterrupted",
  "backupFailed",
] as const;

type T = ReturnType<typeof useTranslations<"instanceBackups">>;

export function backupErrorMessage(t: T, code: string): string {
  return (ERROR_CODES as readonly string[]).includes(code)
    ? t(`errorCodes.${code as (typeof ERROR_CODES)[number]}`)
    : t("errorCodes.unknown", { code });
}

export function BackupsTab() {
  const t = useTranslations("instanceBackups");
  const data = useSuspenseQuery(getInstanceBackupsQuery()).data;
  const { settings } = data;

  return (
    <div className="flex flex-col gap-4">
      {settings.destinationId === null && (
        <Alert>
          <TriangleAlert className="text-amber-600 dark:text-amber-500" />
          <AlertTitle>{t("notOffsiteTitle")}</AlertTitle>
          <AlertDescription>{t("notOffsiteDescription")}</AlertDescription>
        </Alert>
      )}
      <Alert>
        <KeyRound />
        <AlertTitle>{t("secretsKeyTitle")}</AlertTitle>
        <AlertDescription>
          {t("secretsKeyDescription", {
            fingerprint:
              settings.secretsKeyFingerprint ?? t("secretsKeyNoFingerprint"),
          })}
          <VerifyKey />
        </AlertDescription>
      </Alert>
      <SettingsCard data={data} />
      <HistoryCard backups={data.backups} instance={data.instance} />
    </div>
  );
}

function VerifyKey() {
  const t = useTranslations("instanceBackups");
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [match, setMatch] = useState<boolean | null>(null);

  async function check(event: React.FormEvent) {
    event.preventDefault();
    if (!key.trim()) return;
    setChecking(true);
    try {
      setMatch((await verifySecretsKey(key)).match);
      // Don't keep the pasted key in memory once it has been checked.
      setKey("");
    } catch (error) {
      reportError(error);
    } finally {
      setChecking(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void check(e)}
      className="mt-3 flex w-full max-w-xl flex-col gap-2"
    >
      <label htmlFor="verify-secrets-key" className="text-sm font-medium">
        {t("verifyKeyLabel")}
      </label>
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <PasswordInput
            id="verify-secrets-key"
            autoComplete="off"
            placeholder={t("verifyKeyPlaceholder")}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              if (e.target.value) setMatch(null);
            }}
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={checking || !key.trim()}
        >
          {checking && (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          )}
          {t("verifyKey")}
        </Button>
      </div>
      {match !== null && (
        <p
          aria-live="polite"
          className={
            match
              ? "flex items-center gap-1.5 text-success"
              : "flex items-center gap-1.5 text-destructive"
          }
        >
          {match ? (
            <CircleCheck className="size-4" />
          ) : (
            <CircleX className="size-4" />
          )}
          {match ? t("keyMatches") : t("keyMismatch")}
        </p>
      )}
    </form>
  );
}

function SettingsCard({ data }: { data: InstanceBackupsData }) {
  const t = useTranslations("instanceBackups");
  const tCommon = useTranslations("common");
  const { settings, destinations } = data;

  const count = (min: number, max: number) =>
    z
      .string()
      .trim()
      .regex(/^\d+$/, t("invalidRange", { min, max }))
      .refine(
        (v) => Number(v) >= min && Number(v) <= max,
        t("invalidRange", { min, max })
      );
  const schema = z.object({
    destinationId: z.string(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, t("invalidTime")),
    keepDaily: count(1, 90),
    keepWeekly: count(0, 52),
  });
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      destinationId: settings.destinationId ?? LOCAL,
      time: settings.time,
      keepDaily: String(settings.keepDaily),
      keepWeekly: String(settings.keepWeekly),
    },
  });
  const loading = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !loading);
  const [running, setRunning] = useState(false);

  async function onSubmit(values: Values) {
    try {
      await saveInstanceBackupSettings({
        destinationId:
          values.destinationId === LOCAL ? null : values.destinationId,
        time: values.time,
        keepDaily: Number(values.keepDaily),
        keepWeekly: Number(values.keepWeekly),
      });
    } catch (error) {
      reportError(error);
      return;
    }
    toast.success(t("saved"));
    form.reset(values);
  }

  async function runNow() {
    setRunning(true);
    try {
      await runInstanceBackupNow();
      toast.success(t("runQueued"));
    } catch (error) {
      reportError(error);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settingsTitle")}</CardTitle>
        <CardDescription>{t("settingsDescription")}</CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            onClick={() => void runNow()}
            disabled={running}
          >
            {running ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <DatabaseBackup data-icon="inline-start" />
            )}
            {t("runNow")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex max-w-2xl flex-col gap-4"
          >
            <FormField
              control={form.control}
              name="destinationId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("destination")}</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => field.onChange(value ?? LOCAL)}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={LOCAL}>
                        {t("destinationLocal")}
                      </SelectItem>
                      {destinations.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {t("destinationDescription")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="time"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("time")}</FormLabel>
                  <FormControl>
                    <Input type="time" className="w-32" {...field} />
                  </FormControl>
                  <FormDescription>
                    {t("timeDescription", { zone: settings.timeZone })}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="keepDaily"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("keepDaily")}</FormLabel>
                    <FormControl>
                      <Input type="number" min={1} max={90} {...field} />
                    </FormControl>
                    <FormDescription>
                      {t("keepDailyDescription")}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="keepWeekly"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("keepWeekly")}</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} max={52} {...field} />
                    </FormControl>
                    <FormDescription>
                      {t("keepWeeklyDescription")}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
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

function StatusBadge({ status }: { status: InstanceBackupRow["status"] }) {
  const t = useTranslations("instanceBackups");
  const variant =
    status === "failed"
      ? "destructive"
      : status === "running"
        ? "outline"
        : "secondary";
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>;
}

function HistoryCard({
  backups,
  instance,
}: {
  backups: InstanceBackupRow[];
  instance: string;
}) {
  const t = useTranslations("instanceBackups");
  const [acking, setAcking] = useState<string | null>(null);

  async function acknowledge(id: string) {
    setAcking(id);
    try {
      await acknowledgeInstanceBackup(id);
    } catch (error) {
      reportError(error);
    } finally {
      setAcking(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("historyTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        {backups.length === 0 ? (
          <EmptyState icon={DatabaseBackup} title={t("historyEmpty")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colStarted")}</TableHead>
                <TableHead>{t("colTrigger")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead>{t("colLocation")}</TableHead>
                <TableHead>{t("colVersion")}</TableHead>
                <TableHead className="text-right">{t("colSize")}</TableHead>
                <TableHead>{t("colError")}</TableHead>
                <TableHead className="w-32">
                  <span className="sr-only">{t("colActions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="whitespace-nowrap">
                    <RelativeTime date={b.startedAt} />
                  </TableCell>
                  <TableCell>{t(`trigger.${b.trigger}`)}</TableCell>
                  <TableCell>
                    <StatusBadge status={b.status} />
                  </TableCell>
                  <TableCell>{t(`location.${b.location}`)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {b.version}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {b.sizeBytes === null ? "—" : formatBytes(b.sizeBytes)}
                  </TableCell>
                  <TableCell className="max-w-72 whitespace-normal text-sm">
                    {b.errorCode ? backupErrorMessage(t, b.errorCode) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    {b.status === "succeeded" && b.objectKey && (
                      <RestoreDialog
                        instance={instance}
                        version={b.version}
                        triggerLabel={t("restore")}
                        onConfirm={(confirm) =>
                          restoreInstanceBackup(b.id, confirm)
                        }
                      />
                    )}
                    {b.status === "failed" &&
                      (b.acknowledgedAt ? (
                        <span className="text-xs text-muted-foreground">
                          {t("acknowledged")}
                        </span>
                      ) : (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={acking === b.id}
                          onClick={() => void acknowledge(b.id)}
                        >
                          <Check />
                          {t("acknowledge")}
                        </Button>
                      ))}
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
