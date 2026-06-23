"use client";

import {
  ArrowDown,
  Braces,
  CircleAlert,
  Download,
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
  LogContent,
  type LogLevel,
  type ParsedLog,
  parseLogLine,
} from "@/lib/log-render";
import {
  LOG_LINE_OPTIONS,
  type LogLines,
  type ServiceRole,
} from "@/lib/services";
import { cn } from "@/lib/utils";

export type LevelFilter = "all" | NonNullable<LogLevel>;

const LEVEL_FILTER_OPTIONS: LevelFilter[] = [
  "all",
  "error",
  "warn",
  "info",
  "debug",
];

// Serializable view state — mirrored into the URL by the full-page viewer so
// a filtered view is shareable / bookmarkable / reload-safe. The dialog leaves
// `onStateChange` unset and keeps this purely ephemeral.
export type LogViewerState = {
  tail: LogLines;
  q: string;
  level: LevelFilter;
  view: "pretty" | "raw";
};

type LogEntry = {
  id: number;
  text: string;
  level: LogLevel;
  parsed: ParsedLog;
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
// Debounce URL writes so per-keystroke filter changes don't spam history.
const STATE_SYNC_DEBOUNCE_MS = 350;

type Props = {
  project: SafeProjectWithServers;
  role: ServiceRole;
  serviceName: string;
  // Seed view state (defaults: tail=200, q="", level="all", view="pretty").
  initial?: Partial<LogViewerState>;
  // Called (debounced) whenever view state changes — used to sync to the URL.
  onStateChange?: (state: LogViewerState) => void;
  // Show the severity dropdown. Off by default to keep the toolbar lean.
  showLevelFilter?: boolean;
  // Sizing/layout applied to the root — parents own height (page flex-1, …).
  // The viewer fills whatever box it's given.
  className?: string;
};

export function LogViewer({
  project,
  role,
  serviceName,
  initial,
  onStateChange,
  showLevelFilter = false,
  className,
}: Props) {
  const t = useTranslations("services");
  const [initialLines, setInitialLines] = React.useState<LogLines>(
    initial?.tail ?? 200
  );
  const [entries, setEntries] = React.useState<LogEntry[]>([]);
  const [streamState, setStreamState] = React.useState<StreamState>("idle");
  const [streamError, setStreamError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState(initial?.q ?? "");
  const [level, setLevel] = React.useState<LevelFilter>(
    initial?.level ?? "all"
  );
  const [pretty, setPretty] = React.useState(initial?.view !== "raw");
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

        const next: LogEntry[] = incoming.map((text) => {
          const parsed = parseLogLine(text);
          return {
            id: ++idRef.current,
            text,
            level: parsed.level,
            parsed,
          };
        });

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

  // Connect on mount, tear down on unmount. Parents that need a fresh stream
  // for a different service (the dialog) remount via a `key` on the role, so a
  // plain mount effect is enough — no role-change branch to handle here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connect once on mount with the seeded tail
  React.useEffect(() => {
    connect(initialLines);
    return () => {
      closeStream();
    };
  }, []);

  // Mirror serializable view state outward (URL sync), debounced so typing in
  // the filter doesn't write a history entry per keystroke. Skip the first run
  // so mounting with seed state doesn't immediately rewrite the URL.
  const onStateChangeRef = React.useRef(onStateChange);
  React.useEffect(() => {
    onStateChangeRef.current = onStateChange;
  });
  const firstSync = React.useRef(true);
  React.useEffect(() => {
    if (!onStateChangeRef.current) return;
    if (firstSync.current) {
      firstSync.current = false;
      return;
    }
    const id = setTimeout(() => {
      onStateChangeRef.current?.({
        tail: initialLines,
        q: filter,
        level,
        view: pretty ? "pretty" : "raw",
      });
    }, STATE_SYNC_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [initialLines, filter, level, pretty]);

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
    const q = filter.toLowerCase();
    if (!q && level === "all") return entries;
    return entries.filter((e) => {
      if (level !== "all" && e.level !== level) return false;
      if (q && !e.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, filter, level]);

  const copyText = React.useMemo(
    () => entries.map((e) => e.text).join("\n"),
    [entries]
  );

  const isConnecting = streamState === "connecting";
  const isPaused = streamState === "paused";
  const isFiltering = Boolean(filter) || level !== "all";

  return (
    <div className={cn("flex flex-col min-h-0 gap-3", className)}>
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

        {showLevelFilter && (
          <Select
            value={level}
            onValueChange={(v) => setLevel(v as LevelFilter)}
          >
            <SelectTrigger
              size="sm"
              className="w-32"
              aria-label={t("logs.levelLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVEL_FILTER_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt === "all" ? t("logs.levelAll") : opt.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

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
          variant={pretty ? "default" : "outline"}
          size="sm"
          onClick={() => setPretty((p) => !p)}
          aria-pressed={pretty}
          aria-label={t("logs.formatToggle")}
          title={pretty ? t("logs.viewPretty") : t("logs.viewRaw")}
        >
          <Braces className="size-4" />
        </Button>

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
          <RefreshCw className={cn("size-4", isConnecting && "animate-spin")} />
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

      <div className="rounded-md border bg-card overflow-hidden flex flex-col min-h-0 flex-1 relative">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30 text-xs text-muted-foreground shrink-0">
          <Terminal className="size-3.5" />
          <StreamBadge state={streamState} t={t} />
          <span className="ml-auto tabular-nums">
            {isFiltering
              ? `${filtered.length}/${entries.length}`
              : entries.length}{" "}
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
                  : isFiltering
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
                <LogContent parsed={entry.parsed} pretty={pretty} />
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
    </div>
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
