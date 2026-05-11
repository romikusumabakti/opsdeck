"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { getRunningTasks, type RunningTask } from "@/actions/tasks";
import { LiveTaskDialog } from "@/components/live-task-dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const POLL_INTERVAL_MS = 8000;

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

export function ActiveTasksIndicator() {
  const t = useTranslations("activeTasks");
  const [tasks, setTasks] = React.useState<RunningTask[]>([]);
  const [open, setOpen] = React.useState(false);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());

  // Poll for running tasks. Pause when the tab is hidden so a backgrounded
  // window doesn't keep hammering the DB. A visibility flip triggers an
  // immediate refresh so the badge is fresh when the user returns.
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const next = await getRunningTasks();
        if (cancelled) return;
        setTasks(next);
      } finally {
        if (!cancelled && document.visibilityState === "visible") {
          timer = setTimeout(tick, POLL_INTERVAL_MS);
        }
      }
    }

    function onVisibility() {
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        tick();
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Tick the elapsed display once a second only while something is running.
  React.useEffect(() => {
    if (tasks.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [tasks.length]);

  const count = tasks.length;
  const activeTask = activeTaskId
    ? (tasks.find((task) => task.id === activeTaskId) ?? null)
    : null;

  // Keep the dialog mounted while a user has one selected, even if that task
  // has just finished and dropped out of the running list. Closing the dialog
  // returns the indicator to its idle (hidden) state if no other tasks remain.
  if (count === 0 && activeTaskId === null) {
    return null;
  }

  return (
    <>
      {count > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 h-8 px-2"
              aria-label={t("trigger", { count })}
            >
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="text-xs font-medium tabular-nums">{count}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="px-3 py-2 border-b">
              <p className="text-sm font-medium">{t("title")}</p>
              <p className="text-xs text-muted-foreground">
                {t("subtitle", { count })}
              </p>
            </div>
            <ul className="max-h-72 overflow-auto py-1">
              {tasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setActiveTaskId(task.id);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-accent flex items-start gap-2 transition-colors"
                  >
                    <Loader2 className="size-3.5 animate-spin text-primary mt-0.5 shrink-0" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium truncate">
                        {task.description}
                      </span>
                      <span className="block text-xs text-muted-foreground truncate">
                        {task.project?.name ?? "—"} ·{" "}
                        {formatElapsed(task.runAt, now)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
      <LiveTaskDialog
        taskId={activeTaskId}
        onOpenChange={(isOpen) => {
          if (!isOpen) setActiveTaskId(null);
        }}
        title={activeTask?.description ?? t("title")}
      />
    </>
  );
}
