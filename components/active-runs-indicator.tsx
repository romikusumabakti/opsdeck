"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import type { ActiveRun } from "@/actions/runs";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useRunCompletionNotifications } from "@/hooks/use-run-notifications";

function toMs(value: Date | string): number {
  // Server actions serialize Date to string over the wire — TS types still
  // claim Date, so accept both at runtime to avoid NaN from .getTime().
  return typeof value === "string" ? Date.parse(value) : value.getTime();
}

function formatElapsed(from: Date | string, now: number): string {
  const ms = Math.max(0, now - toMs(from));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

export function ActiveRunsIndicator() {
  const t = useTranslations("activeTasks");
  const [runs, setTasks] = React.useState<ActiveRun[]>([]);
  const [open, setOpen] = React.useState(false);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());

  useRunCompletionNotifications(runs, {
    titleSuccess: t("notifyTitleSuccess"),
    titleFailed: t("notifyTitleFailed"),
  });

  // Subscribe to a server-sent stream of the running-run list. The server
  // polls the DB and pushes diffs, so we get fresh state without each client
  // hammering the DB on its own timer. EventSource auto-reconnects on
  // transient errors and after the server's 10-minute max-duration close.
  React.useEffect(() => {
    const es = new EventSource("/api/runs/running/stream");

    es.addEventListener("snapshot", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as ActiveRun[];
        setTasks(data);
      } catch {
        /* ignore malformed frame */
      }
    });

    return () => {
      es.close();
    };
  }, []);

  // Tick the elapsed display once a second only while something is running.
  React.useEffect(() => {
    if (runs.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [runs.length]);

  const count = runs.length;
  const activeTask = activeTaskId
    ? (runs.find((run) => run.id === activeTaskId) ?? null)
    : null;

  // Keep the dialog mounted while a user has one selected, even if that run
  // has just finished and dropped out of the running list. Closing the dialog
  // returns the indicator to its idle (hidden) state if no other runs remain.
  if (count === 0 && activeTaskId === null) {
    return null;
  }

  return (
    <>
      {count > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 h-8 px-2"
                aria-label={t("trigger", { count })}
              />
            }
          >
            <Loader2 className="size-4 animate-spin text-primary" />
            <span className="text-xs font-medium tabular-nums">{count}</span>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="px-3 py-2 border-b">
              <p className="text-sm font-medium">{t("title")}</p>
              <p className="text-xs text-muted-foreground">
                {t("subtitle", { count })}
              </p>
            </div>
            <ul className="max-h-72 overflow-auto py-1">
              {runs.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setActiveTaskId(run.id);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-accent flex items-start gap-2 transition-colors"
                  >
                    <Loader2 className="size-3.5 animate-spin text-primary mt-0.5 shrink-0" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium truncate">
                        {run.description}
                      </span>
                      <span className="block text-xs text-muted-foreground truncate">
                        {run.project?.name ?? "—"} ·{" "}
                        {formatElapsed(run.runAt, now)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
      <LiveRunDialog
        runId={activeTaskId}
        onOpenChange={(isOpen) => {
          if (!isOpen) setActiveTaskId(null);
        }}
        title={activeTask?.description ?? t("title")}
      />
    </>
  );
}
