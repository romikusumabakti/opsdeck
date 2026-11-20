import { useMutation } from "@tanstack/react-query";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  missingRequiredNames,
  SHARED_DEPLOY_DIR_MESSAGE,
} from "@/lib/variables/errors";
import { ApiError } from "@/web/api/client";
import {
  type EnvFilePreview,
  type EnvFilePreviewChange,
  type EnvFilePreviewDir,
  previewEnvFile,
  setEnvFileManaged,
} from "@/web/api/variables";
import { IMPORT_MASK } from "./import-review";
import { useVariableErrorText } from "./variable-form-dialog";

// The managed `.env` preview (B§5): per deploy dir, what the next deploy
// would write compared with the live file. Opened by turning the managed
// switch on ("enable") or by a "Preview .env" link ("view", read-only).

export type EnvFilePreviewMode = "enable" | "view";

/** Localized text for a refusal of the managed switch (on or off). */
export function useManagedSwitchErrorText() {
  const t = useTranslations("variables");
  const errorText = useVariableErrorText();
  return (error: unknown): string => {
    const conflict = error instanceof ApiError && error.status === 409;
    const names = conflict ? missingRequiredNames(error.message) : null;
    if (names) return t("missingRequired", { names: names.join(", ") });
    if (conflict && error.message === SHARED_DEPLOY_DIR_MESSAGE) {
      return t("sharedDeployDir");
    }
    return errorText(error);
  };
}

/**
 * Localized text for a preview that could not load. The strong sign-in
 * refusal arrives already localized (apiFetch), as for the reveal.
 */
function usePreviewErrorText() {
  const tDeploys = useTranslations("deploys");
  const tImport = useTranslations("variables.import.errors");
  const errorText = useVariableErrorText();
  return (error: unknown): string => {
    if (error instanceof ApiError) {
      if (error.code === "deployDisabled") return tDeploys("deployDisabled");
      if (error.code === "envFileInvalid") return tImport("envFileInvalid");
    }
    return errorText(error);
  };
}

const dirLabel = (dir: EnvFilePreviewDir) =>
  `${dir.serverName}:${dir.deployDir}`;

/** The figures the switch decides on. */
function summarize(preview: EnvFilePreview) {
  const changes = preview.dirs.reduce((n, d) => n + d.changes.length, 0);
  const notCompared = preview.dirs.filter((d) => d.status === "notCompared");
  const shared = preview.dirs.filter((d) => d.sharedDir);
  return {
    changes,
    notCompared,
    shared,
    clean: changes === 0 && notCompared.length === 0 && shared.length === 0,
    // Enables without a click: something was compared and nothing changes.
    // With no deploy dir at all the user reads that first and clicks Enable.
    auto:
      preview.dirs.length > 0 &&
      changes === 0 &&
      notCompared.length === 0 &&
      shared.length === 0,
  };
}

export function EnvFilePreviewDialog({
  open,
  onOpenChange,
  environmentId,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  mode: EnvFilePreviewMode;
}) {
  const t = useTranslations("variables.envPreview");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] max-h-[calc(100dvh-2rem)] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {t(mode === "enable" ? "titleEnable" : "titleView")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every opening reads the files again. */}
        {open && (
          <PreviewBody
            environmentId={environmentId}
            mode={mode}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({
  environmentId,
  mode,
  onDone,
}: {
  environmentId: string;
  mode: EnvFilePreviewMode;
  onDone: () => void;
}) {
  const t = useTranslations("variables.envPreview");
  const tVariables = useTranslations("variables");
  const tCommon = useTranslations("common");
  const previewErrorText = usePreviewErrorText();
  const switchErrorText = useManagedSwitchErrorText();
  const [confirmed, setConfirmed] = React.useState(false);

  const enable = useMutation({
    mutationFn: (acknowledgedChanges: number) =>
      setEnvFileManaged(environmentId, true, acknowledgedChanges),
    onSuccess: () => {
      toast.success(tVariables("managedOn"));
      onDone();
    },
  });

  // Not cached: every opening reads the servers again, and nothing of the
  // preview outlives the dialog.
  const preview = useMutation({
    mutationFn: () => previewEnvFile(environmentId),
    gcTime: 0,
  });

  // Nothing to confirm: the switch goes on at once. A per-call callback, so
  // a dialog closed while the read was pending enables nothing (TanStack
  // Query drops these on unmount; the options' onSuccess would still run).
  const load = () =>
    preview.mutate(undefined, {
      onSuccess: (result) => {
        if (mode === "enable" && summarize(result).auto) enable.mutate(0);
      },
    });

  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    load();
  });

  const result = preview.data;
  const summary = result ? summarize(result) : null;
  const needsConfirm = summary !== null && !summary.clean;
  const canEnable =
    summary !== null &&
    summary.shared.length === 0 &&
    (!needsConfirm || confirmed) &&
    !enable.isPending;

  return (
    <>
      <div className="-mx-6 flex min-h-0 flex-col gap-4 overflow-y-auto px-6">
        {preview.isPending && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("loading")}
          </p>
        )}

        {preview.isError && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>
              <p>{previewErrorText(preview.error)}</p>
              {mode === "enable" && <p>{t("stillOff")}</p>}
            </AlertDescription>
          </Alert>
        )}

        {result && summary && (
          <PreviewSummary
            summary={summary}
            dirs={result.dirs}
            enabling={mode === "enable" && summary.auto && enable.isPending}
          />
        )}

        {enable.isError && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{switchErrorText(enable.error)}</AlertDescription>
          </Alert>
        )}

        {result?.dirs.map((dir) => (
          <DirPreview key={dirLabel(dir)} dir={dir} />
        ))}

        {mode === "enable" && needsConfirm && summary.shared.length === 0 && (
          <Field orientation="horizontal">
            <Checkbox
              id="env-preview-confirm"
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />
            <FieldLabel htmlFor="env-preview-confirm" className="font-normal">
              {t("confirm")}
            </FieldLabel>
          </Field>
        )}
      </div>
      <DialogFooter>
        {preview.isError && (
          <Button variant="outline" onClick={load}>
            <RefreshCw data-icon="inline-start" />
            {tCommon("tryAgain")}
          </Button>
        )}
        <Button variant="outline" onClick={onDone}>
          {mode === "enable" ? tCommon("cancel") : tCommon("close")}
        </Button>
        {mode === "enable" && summary && (
          <Button
            disabled={!canEnable}
            onClick={() => enable.mutate(summary.changes)}
          >
            {enable.isPending && (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            )}
            {t("enable")}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function PreviewSummary({
  summary,
  dirs,
  enabling,
}: {
  summary: ReturnType<typeof summarize>;
  dirs: readonly EnvFilePreviewDir[];
  enabling: boolean;
}) {
  const t = useTranslations("variables.envPreview");
  const tVariables = useTranslations("variables");
  if (summary.shared.length > 0) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertDescription>
          <p>{tVariables("sharedDeployDir")}</p>
          <p className="font-mono text-xs" dir="ltr">
            {summary.shared.map(dirLabel).join(", ")}
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  if (summary.clean) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        {enabling && <Loader2 className="size-4 animate-spin" aria-hidden />}
        {dirs.length === 0 ? t("noDirs") : t("noChanges")}
      </p>
    );
  }
  return (
    <Alert>
      <TriangleAlert />
      <AlertDescription>
        {summary.changes > 0 && (
          <p>{t("changesWarning", { count: summary.changes })}</p>
        )}
        {summary.notCompared.length > 0 && (
          <>
            <p>{t("notComparedWarning")}</p>
            <p className="font-mono text-xs" dir="ltr">
              {summary.notCompared.map(dirLabel).join(", ")}
            </p>
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}

function DirPreview({ dir }: { dir: EnvFilePreviewDir }) {
  const t = useTranslations("variables.envPreview");
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span className="min-w-0 truncate font-mono" dir="ltr">
          {dirLabel(dir)}
        </span>
        <Badge
          variant={
            dir.status === "compared"
              ? "outline"
              : dir.status === "fileMissing"
                ? "secondary"
                : "destructive"
          }
        >
          {t(`dirStatus.${dir.status}`)}
        </Badge>
        {dir.unchangedCount > 0 && (
          <span className="text-xs font-normal text-muted-foreground">
            {t("unchanged", { count: dir.unchangedCount })}
          </span>
        )}
      </h3>
      {dir.changes.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colChange")}</TableHead>
                <TableHead>{t("colLive")}</TableHead>
                <TableHead>{t("colManaged")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dir.changes.map((change) => (
                <ChangeRow key={change.name} change={change} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function ChangeRow({ change }: { change: EnvFilePreviewChange }) {
  const t = useTranslations("variables.envPreview");
  return (
    <TableRow className={cn(change.reserved && "text-destructive")}>
      <TableCell className="align-top">
        <div className="flex flex-col items-start gap-1">
          <code className="font-mono text-sm break-all">{change.name}</code>
          {change.reserved && (
            <Badge variant="destructive">{t("reserved")}</Badge>
          )}
          {change.panelWritten && (
            <Badge variant="secondary">{t("appWritten")}</Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="align-top">
        <Badge variant={change.reserved ? "destructive" : "outline"}>
          {t(`status.${change.status}`)}
        </Badge>
      </TableCell>
      <TableCell className="max-w-56 align-top">
        <ChangeValue
          change={change}
          value={change.before}
          absent={change.status === "added"}
        />
      </TableCell>
      <TableCell className="max-w-56 align-top">
        {change.status === "removed" ? (
          <ChangeValue change={change} value={undefined} absent />
        ) : change.panelWritten && change.after === undefined ? (
          <span className="text-sm italic text-muted-foreground">
            {t("setAtDeploy")}
          </span>
        ) : (
          <ChangeValue change={change} value={change.after} absent={false} />
        )}
      </TableCell>
    </TableRow>
  );
}

/** One side of a change: the value, the mask, or "not in the file". */
function ChangeValue({
  change,
  value,
  absent,
}: {
  change: EnvFilePreviewChange;
  value: string | undefined;
  absent: boolean;
}) {
  const t = useTranslations("variables.envPreview");
  const tVariables = useTranslations("variables");
  if (absent) {
    return <span className="text-sm text-muted-foreground">{t("absent")}</span>;
  }
  if (change.masked || value === undefined) {
    // Six dots whatever the value: its length is not disclosed.
    return (
      <span className="font-mono text-sm text-muted-foreground">
        <span aria-hidden>{IMPORT_MASK}</span>
        <span className="sr-only">{t("valueHidden")}</span>
      </span>
    );
  }
  return (
    <code className="block truncate font-mono text-sm" title={value} dir="ltr">
      {value === "" ? (
        <span className="italic text-muted-foreground">
          {tVariables("emptyValue")}
        </span>
      ) : (
        value
      )}
    </code>
  );
}
