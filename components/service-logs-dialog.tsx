"use client";

import {
  ArrowDown,
  CircleAlert,
  Download,
  FileText,
  Filter,
  Pause,
  Play,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SafeProjectWithServers } from "@/lib/db/schema";
import {
  detectLogLevel,
  type LogLevel,
  renderAnsiLine,
} from "@/lib/log-render";
import {
  LOG_LINE_OPTIONS,
  type LogLines,
  type ServiceRole,
} from "@/lib/services";
import { cn } from "@/lib/utils";

type Props = {
  project: SafeProjectWithServers;
  role: ServiceRole | null;
  serviceName: string;
  serverName: string;
  title: string;
  onOpenChange: (open: boolean) => void;
};

type LogEntry = {
  id: number;
  text: string;
  level: LogLevel;
};

type StreamState = "idle" | "connecting" | "live" | "paused" | "error";

// Ring-buffer cap: more than 5000 rendered lines is rare for spot-checking
// and cheap to render with CSS `contain` + plain block layout. Going higher
// would push us toward virtualization, which is overkill for an ops panel.
const MAX_ENTRIES = 5000;
// Anchor tolerance: scroll positions within this many pixels of the bottom
// count as "at bottom" for sticky-tail purposes. Accounts for sub-pixel
// rounding when zoom isn't 100%.
const BOTTOM_THRESHOLD_PX = 16;

export function ServiceLogsDialog({
  project,
  role,
  serviceName,
  serverName,
  title,
  onOpenChange,
}: Props) {
  const t = useTranslations("services");
  const [initialLines, setInitialLines] = React.useState<LogLines>(200);
  const [entries, setEntries] = React.useState<LogEntry[]>([]);
  const [streamState, setStreamState] = React.useState<StreamState>("idle");
  const [streamError, setStreamError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState("");
  const [atBottom, setAtBottom] = React.useState(true);
  const [pendingNewCount, setPendingNewCount] = React.useState(0);

  const logRef = React.useRef<HTMLDivElement>(null);
  const idRef = React.useRef(0);
  const esRef = React.useRef<EventSource | null>(null);
  // Latest atBottom flag for handlers that don't want to re-subscribe on state
  // changes (the SSE listeners would otherwise be torn down on every scroll).
  const atBottomRef = React.useRef(true);
  React.useEffect(() => {
    atBottomRef.current = atBottom;
  }, [atBottom]);

  const closeStream = React.useCallback(() => {
    const es = esRef.current;
    if (es) {
      es.close();
      esRef.current = null;
    }
  }, []);

  const connect = React.useCallback(
    (linesToTail: LogLines) => {
      if (!role) return;
      closeStream();
      setEntries([]);
      idRef.current = 0;
      setPendingNewCount(0);
      setAtBottom(true);
      atBottomRef.current = true;
      setStreamError(null);
      setStreamState("connecting");

      const url = `/api/projects/${project.id}/services/${role}/logs/stream?lines=${linesToTail}`;
      const es = new EventSource(url);
      esRef.current = es;
      // Local to this connect() invocation — survives across renders without
      // re-subscribing handlers. Lets onerror distinguish "never connected"
      // from "transient blip after streaming started".
      let receivedReady = false;

      es.addEventListener("ready", () => {
        receivedReady = true;
        setStreamState("live");
      });

      es.addEventListener("lines", (ev) => {
        let incoming: string[];
        try {
          incoming = JSON.parse((ev as MessageEvent).data) as string[];
        } catch {
          return;
        }
        if (incoming.length === 0) return;

        const next: LogEntry[] = incoming.map((text) => ({
          id: ++idRef.current,
          text,
          level: detectLogLevel(text),
        }));

        setEntries((prev) => {
          const merged =
            prev.length + next.length > MAX_ENTRIES
              ? [...prev, ...next].slice(-MAX_ENTRIES)
              : [...prev, ...next];
          return merged;
        });

        if (!atBottomRef.current) {
          setPendingNewCount((n) => n + next.length);
        }
      });

      es.addEventListener("close", () => {
        setStreamState("idle");
        es.close();
        esRef.current = null;
      });

      es.addEventListener("timeout", () => {
        setStreamState("idle");
        es.close();
        esRef.current = null;
      });

      es.addEventListener("stream-error", (ev) => {
        let message = "Stream error";
        try {
          const data = JSON.parse((ev as MessageEvent).data) as {
            message?: string;
          };
          if (data.message) message = data.message;
        } catch {
          // keep default
        }
        setStreamError(message);
        setStreamState("error");
        es.close();
        esRef.current = null;
      });

      es.onerror = () => {
        // EventSource auto-reconnects on transient network errors. Only flip to
        // a hard error if we never reached "live" within 5s — check the local
        // `receivedReady` rather than the React state, which would be stale by
        // the time the timeout fires.
        setTimeout(() => {
          if (esRef.current === es && !receivedReady) {
            setStreamError(t("logs.connectionError"));
            setStreamState("error");
            es.close();
            esRef.current = null;
          }
        }, 5000);
      };
    },
    [project.id, role, t, closeStream]
  );

  // Auto-connect on open, tear down on close. The `role` prop being null means
  // dialog is closed — clear state so reopening for a different service does
  // not flash stale output.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  React.useEffect(() => {
    if (role) {
      connect(initialLines);
    } else {
      closeStream();
      setEntries([]);
      setStreamError(null);
      setStreamState("idle");
      setFilter("");
      setPendingNewCount(0);
    }
    return () => {
      closeStream();
    };
  }, [role]);

  // Sticky-tail: keep the view pinned to the bottom unless the user scrolled
  // away. The effect intentionally depends on `entries` (not anything read
  // inside the body) so it fires every time the buffer changes — Biome's
  // exhaustive-deps can't see that link, hence the ignore.
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggered by entries
  React.useLayoutEffect(() => {
    if (!atBottomRef.current) return;
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  function onScroll() {
    const el = logRef.current;
    if (!el) return;
    const isAtBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
    if (isAtBottom !== atBottomRef.current) {
      atBottomRef.current = isAtBottom;
      setAtBottom(isAtBottom);
      if (isAtBottom) setPendingNewCount(0);
    }
  }

  function jumpToLatest() {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    setPendingNewCount(0);
  }

  function togglePause() {
    if (streamState === "live" || streamState === "connecting") {
      closeStream();
      setStreamState("paused");
    } else {
      connect(initialLines);
    }
  }

  function onLinesChange(value: string) {
    const next = Number(value) as LogLines;
    setInitialLines(next);
    connect(next);
  }

  function onDownload() {
    if (entries.length === 0) return;
    const text = entries.map((e) => e.text).join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `${serviceName}-${stamp}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const filtered = React.useMemo(() => {
    if (!filter) return entries;
    const q = filter.toLowerCase();
    return entries.filter((e) => e.text.toLowerCase().includes(q));
  }, [entries, filter]);

  const copyText = React.useMemo(
    () => entries.map((e) => e.text).join("\n"),
    [entries]
  );

  const isConnecting = streamState === "connecting";
  const isPaused = streamState === "paused";

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
              value={String(initialLines)}
              onValueChange={onLinesChange}
              disabled={isConnecting}
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

          <div className="relative">
            <Filter className="size-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("logs.filterPlaceholder")}
              className="h-8 pl-7 w-48 text-xs"
            />
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={togglePause}
            disabled={isConnecting}
            className="ml-auto"
          >
            {isPaused || streamState === "idle" || streamState === "error" ? (
              <>
                <Play className="size-4" />
                {t("logs.resume")}
              </>
            ) : (
              <>
                <Pause className="size-4" />
                {t("logs.pause")}
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => connect(initialLines)}
            disabled={isConnecting}
            aria-label={t("logs.reconnect")}
          >
            <RefreshCw
              className={cn("size-4", isConnecting && "animate-spin")}
            />
          </Button>
          {entries.length > 0 && (
            <CopyButton value={copyText} label={t("logs.copy")} />
          )}
          {entries.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onDownload}
              aria-label={t("logs.download")}
            >
              <Download className="size-4" />
            </Button>
          )}
        </div>

        <div className="rounded-md border bg-card overflow-hidden flex flex-col min-h-0 relative">
          <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30 text-xs text-muted-foreground shrink-0">
            <Terminal className="size-3.5" />
            <StreamBadge state={streamState} t={t} />
            <span className="ml-auto tabular-nums">
              {filter ? `${filtered.length}/${entries.length}` : entries.length}{" "}
              {t("logs.lines")}
            </span>
          </div>

          {streamError && (
            <div className="px-4 py-3 text-sm text-destructive flex items-start gap-2 border-b">
              <CircleAlert className="size-4 shrink-0 mt-0.5" />
              <code className="font-mono text-xs break-all">{streamError}</code>
            </div>
          )}

          <div
            ref={logRef}
            onScroll={onScroll}
            className="font-mono text-xs leading-relaxed bg-background flex-1 min-h-0 overflow-auto"
          >
            {filtered.length === 0 ? (
              <div className="px-4 py-3">
                <span className="text-muted-foreground italic">
                  {isConnecting
                    ? t("logs.loading")
                    : filter
                      ? t("logs.noMatches")
                      : t("logs.empty")}
                </span>
              </div>
            ) : (
              filtered.map((entry) => (
                <div
                  key={entry.id}
                  className={cn(
                    "px-4 py-0.5 whitespace-pre-wrap break-all border-l-2 border-transparent",
                    entry.level === "error" &&
                      "bg-destructive/5 border-l-destructive/60",
                    entry.level === "warn" &&
                      "bg-amber-500/5 border-l-amber-500/60"
                  )}
                >
                  {renderAnsiLine(entry.text)}
                </div>
              ))
            )}
          </div>

          {!atBottom && pendingNewCount > 0 && (
            <Button
              type="button"
              size="sm"
              onClick={jumpToLatest}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
            >
              <ArrowDown className="size-4" />
              {t("logs.jumpToLatest", { count: pendingNewCount })}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StreamBadge({
  state,
  t,
}: {
  state: StreamState;
  t: ReturnType<typeof useTranslations>;
}) {
  const dotClass = cn(
    "inline-block size-2 rounded-full",
    state === "live" && "bg-success animate-pulse",
    state === "connecting" && "bg-primary animate-pulse",
    state === "paused" && "bg-muted-foreground",
    state === "error" && "bg-destructive",
    state === "idle" && "bg-muted-foreground/50"
  );
  const label =
    state === "live"
      ? t("logs.live")
      : state === "connecting"
        ? t("logs.connecting")
        : state === "paused"
          ? t("logs.paused")
          : state === "error"
            ? t("logs.errored")
            : t("logs.disconnected");
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={dotClass} />
      {label}
    </span>
  );
}
