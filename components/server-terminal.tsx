import "@wterm/dom/src/terminal.css";

import { WTerm } from "@wterm/dom";
import { GhosttyCore } from "@wterm/ghostty";
import * as React from "react";
import { useTranslations } from "use-intl";
import {
  HostKeyReviewLink,
  isHostKeyMismatchFrame,
} from "@/components/host-key-mismatch";
import { Button } from "@/components/ui/button";

// The browser half of the terminal, on wterm: rows render as DOM text, so
// native selection, copy and browser find work on them. It runs on the
// libghostty core rather than wterm's built-in one, because a remote shell
// needs the full VT emulation (graphemes, OSC 52 clipboard) that only that
// core has. The route is code-split, so neither the library nor its WASM
// reaches any other page.
//
// Transport: binary frames are tty bytes in both directions, text frames are
// JSON control messages (see lib/terminal/protocol).

type Status = "connecting" | "connected" | "reconnecting" | "closed";

// Must match the `handle /ws/terminal*` route in the Caddyfile. Deliberately a
// constant and not an env var: it has to agree with the Caddyfile, so a
// runtime override would be a knob that looks configurable and isn't.
const WS_PATH = "/ws/terminal";
// 1s, 2s, 4s, 8s, then give up and let the user retry by hand — past the 60s
// grace window there is nothing left to reattach to anyway.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const SCROLLBACK_LINES = 10_000;

// Colours and font come from the app's own tokens, so the terminal follows a
// light/dark switch through CSS alone. Set inline because wterm's stylesheet
// declares these on the `.wterm` element itself, unlayered, which would beat
// any Tailwind utility. The size is the UI's body size (text-sm).
const TERM_STYLE = {
  "--term-fg": "var(--foreground)",
  "--term-bg": "var(--background)",
  "--term-cursor": "var(--foreground)",
  "--term-font-family": "var(--font-mono)",
  "--term-font-size": "0.875rem",
} as React.CSSProperties;

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
  const tErrors = useTranslations("actionErrors");
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = React.useState<Status>("connecting");
  const [error, setError] = React.useState<string | null>(null);
  // The server's host key changed: nothing connects until an admin reviews it
  // on the server page.
  const [hostKeyMismatch, setHostKeyMismatch] = React.useState(false);
  // Bumping this re-runs the effect, which is what "Reconnect" does.
  const [attempt, setAttempt] = React.useState(0);
  // Survives reconnects within the effect's lifetime so a dropped socket
  // reattaches to the same remote shell instead of opening a second one.
  const sessionIdRef = React.useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies(attempt): `attempt` is not read in the body — bumping it is how "Reconnect" forces a full teardown and re-dial, so it must stay in the list.
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;
    // The effect's own copy of "the shell exited cleanly". Reading this back
    // out of React state meant deciding the reconnect inside a setStatus
    // updater — which StrictMode double-invokes in development, scheduling
    // two reconnects, two tickets and two sessions per drop.
    let ended = false;
    const cleanups: (() => void)[] = [];

    (async () => {
      // wterm measures the cell size once the grid mounts; wait for the
      // webfont so that measurement isn't taken against a fallback face.
      const fontFamily = getComputedStyle(host).fontFamily;
      const fontSize = getComputedStyle(host).fontSize;
      const [core] = await Promise.all([
        GhosttyCore.load(),
        document.fonts.load(`${fontSize} ${fontFamily}`).catch(() => {}),
      ]);
      if (disposed) {
        core.dispose();
        return;
      }
      // The core is ours to dispose: WTerm.destroy() leaves a caller-supplied
      // core alone.
      cleanups.push(() => core.dispose());

      const encoder = new TextEncoder();
      // autoResize (the default) refits the grid from a ResizeObserver;
      // onResize only fires when the cell grid actually changes, so a drag
      // doesn't flood the shell with window-change packets.
      const term = new WTerm(host, {
        core,
        cursorBlink: true,
        scrollbackLines: SCROLLBACK_LINES,
        onData: (data) => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(encoder.encode(data));
          }
        },
        // X10 mouse reports are raw bytes, not UTF-8 text.
        onBinary: (data) => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(new Uint8Array(data));
          }
        },
        onResize: (cols, rows) => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ t: "resize", cols, rows }));
          }
        },
        // OSC 52 from the remote shell (tmux, vim). wterm leaves the policy to
        // the host: writes are honoured, reads are never offered. Without a
        // user gesture the browser may refuse, which is fine.
        onClipboardWrite: (text) => {
          void navigator.clipboard?.writeText(text).catch(() => {});
        },
      });
      // Registered BEFORE the next await: an unmount while init is in flight
      // would otherwise run a cleanup list that doesn't know about the grid.
      cleanups.unshift(() => term.destroy());
      await term.init();
      // Second await boundary, second check: nothing below this line should
      // attach handlers to a component that has gone away.
      if (disposed) return;

      const connect = async (): Promise<void> => {
        if (disposed) return;
        setError(null);
        setHostKeyMismatch(false);

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
          let msg:
            | { t: "ready"; sessionId: string }
            | { t: "exit"; code: number | null; signal: string | null }
            | { t: "error"; message: string };
          try {
            msg = JSON.parse(event.data);
          } catch {
            // Not a frame this protocol sends; ignore rather than throw.
            return;
          }
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
            ended = true;
            setStatus("closed");
            term.write(`\r\n\x1b[2m${t("sessionEnded")}\x1b[0m\r\n`);
            return;
          }
          // The sidecar sends a changed host key as its stable code; retrying
          // would only be refused again.
          if (isHostKeyMismatchFrame(msg.message)) {
            ended = true;
            setHostKeyMismatch(true);
            return;
          }
          setError(msg.message);
        };

        ws.onclose = () => {
          if (disposed) return;
          socket = null;
          if (ended) {
            setStatus("closed");
            return;
          }
          const delay = RETRY_DELAYS_MS[retries];
          if (delay === undefined) {
            setStatus("closed");
            return;
          }
          retries++;
          retryTimer = setTimeout(() => void connect(), delay);
          setStatus("reconnecting");
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
  }, [serverId, cwd, attempt, t]);

  return (
    <div className="flex flex-col gap-2">
      {/* The frame carries the border; wterm mounts on the inner div and
          sizes the grid from its content box, so the padding lives there.
          `!` because wterm's own padding, radius and shadow sit in an
          unlayered stylesheet that beats Tailwind's utilities layer.
          The height is rounded down to whole pixels: on input wterm scrolls
          to the native bottom, then the render scrolls to its own rounded
          bottom. With a fractional height (70vh) Firefox keeps fractional
          scroll offsets, so the two differ and the text jitters on every
          keystroke once there is scrollback. */}
      <div className="h-[70vh] w-full overflow-hidden rounded-lg border">
        <div
          ref={hostRef}
          // Terminal rows are laid out left to right — force the host LTR
          // regardless of the page's own direction under /ar.
          dir="ltr"
          style={TERM_STYLE}
          className="h-[round(down,100%,1px)] w-full rounded-none! p-2! font-mono shadow-none!"
        />
      </div>
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
          {hostKeyMismatch && (
            <span className="text-destructive">
              · {tErrors("hostKeyMismatch")}{" "}
              <HostKeyReviewLink serverId={serverId}>
                {t("reviewHostKey")}
              </HostKeyReviewLink>
            </span>
          )}
        </span>
        {(status === "closed" || error || hostKeyMismatch) && (
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
