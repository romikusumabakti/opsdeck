"use client";

import "@xterm/xterm/css/xterm.css";

import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import * as React from "react";
import { Button } from "@/components/ui/button";

// The browser half of the terminal. xterm reaches for `window` during
// construction, so the library is imported inside the effect rather than at
// module scope — that also keeps it out of the initial bundle for every other
// page.
//
// Transport: binary frames are tty bytes in both directions, text frames are
// JSON control messages (see lib/terminal/protocol).

type Status = "connecting" | "connected" | "reconnecting" | "closed";

// Matches Tailwind's neutral scale so the terminal doesn't look pasted in.
const THEMES = {
  dark: { background: "#0a0a0a", foreground: "#ededed", cursor: "#ededed" },
  light: { background: "#ffffff", foreground: "#171717", cursor: "#171717" },
} as const;

const WS_PATH = process.env.NEXT_PUBLIC_TERMINAL_WS_PATH ?? "/ws/terminal";
// 1s, 2s, 4s, 8s, then give up and let the user retry by hand — past the 60s
// grace window there is nothing left to reattach to anyway.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${WS_PATH}`;
}

export function ServerTerminal({
  serverId,
  cwd,
}: {
  serverId: string;
  cwd?: string;
}) {
  const t = useTranslations("terminal");
  const { resolvedTheme } = useTheme();
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = React.useState<Status>("connecting");
  const [error, setError] = React.useState<string | null>(null);
  // Bumping this re-runs the effect, which is what "Reconnect" does.
  const [attempt, setAttempt] = React.useState(0);
  // Survives reconnects within the effect's lifetime so a dropped socket
  // reattaches to the same remote shell instead of opening a second one.
  const sessionIdRef = React.useRef<string | null>(null);

  const theme = resolvedTheme === "light" ? THEMES.light : THEMES.dark;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;
    const cleanups: (() => void)[] = [];

    (async () => {
      const [
        { Terminal },
        { FitAddon },
        { WebLinksAddon },
        { ClipboardAddon },
        { Unicode11Addon },
      ] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-clipboard"),
        import("@xterm/addon-unicode11"),
      ]);
      if (disposed) return;

      const term = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily:
          'var(--font-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace)',
        fontSize: 13,
        scrollback: 10_000,
        theme,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.loadAddon(new ClipboardAddon());
      const unicode = new Unicode11Addon();
      term.loadAddon(unicode);
      term.unicode.activeVersion = "11";
      term.open(host);

      // WebGL is an optimisation, not a requirement: a machine without a
      // working context (VM, remote desktop, blocklisted driver) must still
      // get a terminal, so a failure here is swallowed.
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // Canvas/DOM renderer it is.
      }

      fit.fit();
      cleanups.push(() => term.dispose());

      const encoder = new TextEncoder();
      term.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(encoder.encode(data));
        }
      });
      term.onResize(({ cols, rows }) => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: "resize", cols, rows }));
        }
      });

      // One fit per frame: a drag-resize fires dozens of observer callbacks,
      // and each fit that changes geometry sends a window-change packet.
      let frame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          try {
            fit.fit();
          } catch {
            // The element can be mid-teardown.
          }
        });
      });
      observer.observe(host);
      cleanups.push(() => {
        cancelAnimationFrame(frame);
        observer.disconnect();
      });

      const connect = async (): Promise<void> => {
        if (disposed) return;
        setError(null);

        let ticket: string;
        try {
          const res = await fetch("/api/terminal/ticket", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ serverId, cwd }),
          });
          if (!res.ok) throw new Error(`ticket ${res.status}`);
          ticket = ((await res.json()) as { ticket: string }).ticket;
        } catch {
          if (disposed) return;
          setStatus("closed");
          setError(t("ticketFailed"));
          return;
        }
        if (disposed) return;

        const ws = new WebSocket(socketUrl());
        ws.binaryType = "arraybuffer";
        socket = ws;

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              t: "hello",
              ticket,
              cols: term.cols,
              rows: term.rows,
              ...(sessionIdRef.current
                ? { sessionId: sessionIdRef.current }
                : {}),
            })
          );
        };

        ws.onmessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") {
            term.write(new Uint8Array(event.data as ArrayBuffer));
            return;
          }
          const msg = JSON.parse(event.data) as
            | { t: "ready"; sessionId: string }
            | { t: "exit"; code: number | null; signal: string | null }
            | { t: "error"; message: string };
          if (msg.t === "ready") {
            sessionIdRef.current = msg.sessionId;
            retries = 0;
            setStatus("connected");
            term.focus();
            return;
          }
          if (msg.t === "exit") {
            // The remote shell ended on purpose; reattaching would be wrong.
            sessionIdRef.current = null;
            setStatus("closed");
            term.write(`\r\n\x1b[2m${t("sessionEnded")}\x1b[0m\r\n`);
            return;
          }
          setError(msg.message);
        };

        ws.onclose = () => {
          if (disposed) return;
          socket = null;
          // A clean exit already set "closed"; don't reconnect into a shell
          // that is gone.
          setStatus((current) => {
            if (current === "closed") return current;
            const delay = RETRY_DELAYS_MS[retries];
            if (delay === undefined) return "closed";
            retries++;
            retryTimer = setTimeout(() => void connect(), delay);
            return "reconnecting";
          });
        };
      };

      await connect();
    })();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      for (const cleanup of cleanups.splice(0)) cleanup();
    };
    // `theme` is applied by the separate effect below so a theme switch does
    // not tear down a live shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, cwd, attempt, t]);

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={hostRef}
        className="h-[70vh] w-full overflow-hidden rounded-lg border bg-background p-2"
      />
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={
              status === "connected"
                ? "size-2 rounded-full bg-emerald-500"
                : status === "closed"
                  ? "size-2 rounded-full bg-muted-foreground"
                  : "size-2 animate-pulse rounded-full bg-amber-500"
            }
          />
          {t(`status.${status}`)}
          {error && <span className="text-destructive">· {error}</span>}
        </span>
        {(status === "closed" || error) && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setStatus("connecting");
              setAttempt((n) => n + 1);
            }}
          >
            {t("reconnect")}
          </Button>
        )}
      </div>
    </div>
  );
}
