import * as React from "react";
import type { ConversationMessage } from "@/web/api/assistant";
import { messageStreamUrl } from "@/web/api/assistant";

export type StreamSnapshot = Pick<
  ConversationMessage,
  "content" | "status" | "errorCode" | "toolCalls"
>;

const isTerminal = (status: string): status is "done" | "failed" =>
  status === "done" || status === "failed";

/**
 * Follows one unfinished assistant message over SSE and returns its latest
 * snapshot. The EventSource is closed on a terminal snapshot (done/failed),
 * on `not-found`, when the browser gives up on the stream, and on unmount;
 * `onTerminal` then runs once so the caller refetches the conversation,
 * with the terminal status (null when the stream ended without one).
 * While the message is unfinished the browser's own reconnect resumes the
 * stream after the server's `timeout`/`error` close.
 */
export function useMessageStream(
  messageId: string | null,
  onTerminal: (status: "done" | "failed" | null) => void
): StreamSnapshot | null {
  // Tagged with its message, so a previous message's last snapshot is never
  // shown on the next one before the effect below resets it.
  const [state, setState] = React.useState<{
    messageId: string;
    snapshot: StreamSnapshot;
  } | null>(null);
  const onTerminalRef = React.useRef(onTerminal);
  React.useEffect(() => {
    onTerminalRef.current = onTerminal;
  });

  React.useEffect(() => {
    setState(null);
    if (!messageId) return;
    const source = new EventSource(messageStreamUrl(messageId));
    let finished = false;
    const finish = (status: "done" | "failed" | null = null) => {
      source.close();
      if (finished) return;
      finished = true;
      onTerminalRef.current(status);
    };
    source.addEventListener("snapshot", (event) => {
      let data: StreamSnapshot | null = null;
      try {
        data = JSON.parse((event as MessageEvent<string>).data);
      } catch {
        // A malformed frame: stop following and show the stored state.
      }
      if (!data || typeof data.status !== "string") {
        finish();
        return;
      }
      setState({ messageId, snapshot: data });
      if (isTerminal(data.status)) finish(data.status);
    });
    source.addEventListener("not-found", () => finish());
    source.onerror = () => {
      // CLOSED: refused (a non-200) and never retried; refetch to show the
      // stored state instead of spinning.
      if (source.readyState === EventSource.CLOSED) finish();
    };
    return () => {
      finished = true;
      source.close();
    };
  }, [messageId]);

  return state && state.messageId === messageId ? state.snapshot : null;
}
