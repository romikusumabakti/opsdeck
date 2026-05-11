"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Loader2,
  Terminal,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type TaskStatus = "started" | "success" | "failed";

type TaskSnapshot = {
  id: string;
  description: string;
  status: TaskStatus;
  output: string;
  errorMessage: string | null;
  runAt: string;
  completedAt: string | null;
};

type Props = {
  taskId: string;
  // Optional: keeps the panel mounted by parent so it can be dismissed.
  onDismiss?: () => void;
  // Fires once when the task transitions into success — handy for parents
  // that want to surface a result (e.g. copy generated filename to clipboard).
  onSuccess?: (snapshot: TaskSnapshot) => void;
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

export function LiveTaskPanel({ taskId, onDismiss, onSuccess }: Props) {
  const t = useTranslations("liveTask");
  const [snapshot, setSnapshot] = React.useState<TaskSnapshot | null>(null);
  const [streamError, setStreamError] = React.useState<string | null>(null);
  const [logsOpen, setLogsOpen] = React.useState(true);
  const logRef = React.useRef<HTMLPreElement>(null);
  const userScrolledRef = React.useRef(false);
  const [now, setNow] = React.useState(() => Date.now());

  // Tick every second so the elapsed counter advances while running. Stop the
  // ticker once the task is in a terminal state to avoid wasted renders.
  React.useEffect(() => {
    if (snapshot && snapshot.status !== "started") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [snapshot]);

  // Track latest snapshot via ref so the EventSource error handler can read it
  // without forcing the effect to re-subscribe whenever it changes.
  const snapshotRef = React.useRef(snapshot);
  React.useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  // Latest onSuccess via ref so the EventSource effect doesn't have to
  // re-subscribe whenever the parent passes a fresh callback reference.
  const onSuccessRef = React.useRef(onSuccess);
  React.useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);
  // Guard against firing the callback twice if the server replays the final
  // snapshot (e.g. on resume after a transient disconnect).
  const successFiredRef = React.useRef(false);

  React.useEffect(() => {
    setSnapshot(null);
    setStreamError(null);
    successFiredRef.current = false;
    const es = new EventSource(`/api/tasks/${taskId}/stream`);

    es.addEventListener("snapshot", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as TaskSnapshot;
        setSnapshot(data);
        if (
          data.status === "success" &&
          !successFiredRef.current &&
          onSuccessRef.current
        ) {
          successFiredRef.current = true;
          onSuccessRef.current(data);
        }
        if (data.status !== "started") {
          es.close();
        }
      } catch {
        /* ignore malformed frame */
      }
    });

    es.addEventListener("not-found", () => {
      setStreamError(t("notFound"));
      es.close();
    });

    es.addEventListener("timeout", () => {
      es.close();
    });

    es.onerror = () => {
      // EventSource auto-reconnects on transient errors. We only surface a
      // hard error if no snapshot has arrived within 5s.
      setTimeout(() => {
        if (!snapshotRef.current) setStreamError(t("connectionError"));
      }, 5000);
    };

    return () => {
      es.close();
    };
  }, [taskId, t]);

  // Auto-scroll log viewer to bottom unless the user has scrolled up. Trigger
  // intentionally listens to `snapshot?.output` even though the body doesn't
  // textually reference it — Biome's static analysis can't see that link.
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggered by output changes
  React.useEffect(() => {
    const el = logRef.current;
    if (!el || !logsOpen) return;
    if (userScrolledRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [snapshot?.output, logsOpen]);

  function onScroll() {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    userScrolledRef.current = !atBottom;
  }

  const status: TaskStatus = snapshot?.status ?? "started";
  const elapsed = snapshot
    ? (snapshot.completedAt ? new Date(snapshot.completedAt).getTime() : now) -
      new Date(snapshot.runAt).getTime()
    : 0;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card overflow-hidden transition-colors",
        status === "success" && "border-emerald-500/40",
        status === "failed" && "border-destructive/50",
        status === "started" && "border-primary/30"
      )}
      aria-live="polite"
    >
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-muted/30">
        <StatusIcon status={status} />
        <div className="flex-1 min-w-0 flex flex-col">
          <span className="text-sm font-medium truncate">
            {snapshot?.description ?? t("starting")}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {t("elapsed", { duration: formatDuration(elapsed) })}
          </span>
        </div>
        <StatusBadge status={status} t={t} />
        {onDismiss && status !== "started" && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDismiss}
            aria-label={t("dismiss")}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      {streamError && (
        <div className="px-4 py-3 text-sm text-destructive border-b flex items-center gap-2">
          <CircleAlert className="size-4 shrink-0" />
          {streamError}
        </div>
      )}

      {snapshot?.errorMessage && (
        <div className="px-4 py-3 text-sm border-b bg-destructive/5 text-destructive">
          <div className="flex items-start gap-2">
            <CircleAlert className="size-4 shrink-0 mt-0.5" />
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              <span className="font-medium">{t("errorLabel")}</span>
              <code className="font-mono text-xs break-all">
                {snapshot.errorMessage}
              </code>
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setLogsOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/40 transition-colors"
      >
        {logsOpen ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
        <Terminal className="size-3.5" />
        <span>{t("logsLabel")}</span>
        <span className="ml-auto tabular-nums text-[10px]">
          {snapshot?.output ? snapshot.output.split("\n").length - 1 : 0}{" "}
          {t("lines")}
        </span>
      </button>

      {logsOpen && (
        <pre
          ref={logRef}
          onScroll={onScroll}
          className="font-mono text-xs leading-relaxed bg-background border-t px-4 py-3 max-h-64 overflow-auto whitespace-pre-wrap"
        >
          {snapshot?.output || (
            <span className="text-muted-foreground italic">
              {t("waitingForOutput")}
            </span>
          )}
        </pre>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === "success")
    return <CheckCircle2 className="size-5 text-emerald-500 shrink-0" />;
  if (status === "failed")
    return <CircleAlert className="size-5 text-destructive shrink-0" />;
  return <Loader2 className="size-5 text-primary animate-spin shrink-0" />;
}

function StatusBadge({
  status,
  t,
}: {
  status: TaskStatus;
  t: (key: string) => string;
}) {
  if (status === "success") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15 border-transparent">
        {t("statusSuccess")}
      </Badge>
    );
  }
  if (status === "failed") {
    return <Badge variant="destructive">{t("statusFailed")}</Badge>;
  }
  return <Badge variant="secondary">{t("statusRunning")}</Badge>;
}
