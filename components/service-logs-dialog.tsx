"use client";

import {
  CircleAlert,
  FileText,
  Loader2,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { getServiceLogs, type ServiceLogsResult } from "@/actions/services";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProjectWithServers } from "@/lib/db/schema";
import {
  LOG_LINE_OPTIONS,
  type LogLines,
  type ServiceRole,
} from "@/lib/services";
import { cn } from "@/lib/utils";

type Props = {
  project: ProjectWithServers;
  role: ServiceRole | null;
  serviceName: string;
  serverName: string;
  title: string;
  onOpenChange: (open: boolean) => void;
};

export function ServiceLogsDialog({
  project,
  role,
  serviceName,
  serverName,
  title,
  onOpenChange,
}: Props) {
  const t = useTranslations("services");
  const tCommon = useTranslations("common");
  const [lines, setLines] = React.useState<LogLines>(200);
  const [result, setResult] = React.useState<ServiceLogsResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const logRef = React.useRef<HTMLPreElement>(null);

  const fetchLogs = React.useCallback(
    async (n: LogLines) => {
      if (!role) return;
      setLoading(true);
      setError(null);
      try {
        const next = await getServiceLogs(project, role, n);
        setResult(next);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : tCommon("errorGeneric");
        setError(message);
        toast.error(message);
      } finally {
        setLoading(false);
      }
    },
    [project, role, tCommon]
  );

  // Fetch on open and whenever the role changes; clear stale output when the
  // dialog closes so reopening for a different service doesn't flash old logs.
  // Intentionally omit `lines` and `fetchLogs` — initial fetch uses the
  // default tail count; subsequent line-count changes are handled by onChange.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  React.useEffect(() => {
    if (role) {
      fetchLogs(lines);
    } else {
      setResult(null);
      setError(null);
    }
  }, [role]);

  // Scroll to the bottom whenever new output arrives — operators usually want
  // the most recent lines first. The body doesn't textually reference
  // `result?.output`, but the side effect should fire on every change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggered by output changes
  React.useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [result?.output]);

  function onLinesChange(value: string) {
    const next = Number(value) as LogLines;
    setLines(next);
    fetchLogs(next);
  }

  const lineCount = result?.output ? result.output.split("\n").length : 0;
  const isEmpty = !loading && !error && result?.output.trim() === "";

  return (
    <Dialog open={role !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl grid-rows-[auto_auto_minmax(0,1fr)] max-h-[calc(100vh-2rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-5 text-muted-foreground" />
            {title}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex items-center gap-1 flex-wrap">
              <code className="font-mono text-xs">{serviceName}</code>
              <span>· {serverName}</span>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t("logs.linesLabel")}
            </span>
            <Select
              value={String(lines)}
              onValueChange={onLinesChange}
              disabled={loading}
            >
              <SelectTrigger size="sm" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOG_LINE_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fetchLogs(lines)}
            disabled={loading}
            className="ml-auto"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            {t("logs.refresh")}
          </Button>
          {result?.output && (
            <CopyButton value={result.output} label={t("logs.copy")} />
          )}
        </div>

        <div className="rounded-md border bg-card overflow-hidden flex flex-col min-h-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30 text-xs text-muted-foreground shrink-0">
            <Terminal className="size-3.5" />
            <span>{t("logs.outputLabel")}</span>
            <span className="ml-auto tabular-nums">
              {lineCount} {t("logs.lines")}
            </span>
          </div>

          {error ? (
            <div className="px-4 py-3 text-sm text-destructive flex items-start gap-2">
              <CircleAlert className="size-4 shrink-0 mt-0.5" />
              <code className="font-mono text-xs break-all">{error}</code>
            </div>
          ) : (
            <pre
              ref={logRef}
              className="font-mono text-xs leading-relaxed bg-background px-4 py-3 flex-1 min-h-0 overflow-auto whitespace-pre-wrap"
            >
              {loading && !result ? (
                <span className="text-muted-foreground italic inline-flex items-center gap-2">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("logs.loading")}
                </span>
              ) : isEmpty ? (
                <span className="text-muted-foreground italic">
                  {t("logs.empty")}
                </span>
              ) : (
                result?.output
              )}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
