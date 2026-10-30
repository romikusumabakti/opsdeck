import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";

// Server-sent events for the run, log and mail streams.
//
// A thin wrapper over hono's streamSSE that restores the headers the Next
// handlers sent: streamSSE sets a bare `no-cache`, and these streams also need
// `no-transform` (no proxy may compress or rewrite them) and
// `X-Accel-Buffering: no` (nginx-style proxies must flush every event at once).
// Nothing in the app compresses responses, so events leave as they are written.
//
// No onError is passed to streamSSE on purpose: its default reply writes the
// exception's message to the client as an `error` event, which would leak
// internals. Without one, a throw is logged and the stream closes; each caller
// catches its own failures and sends a generic event instead.
//
// Callers authenticate and authorize before calling this — once the stream is
// open the status is 200 and can no longer say 401/403/404.
export function eventStream(
  c: Context,
  run: (stream: SSEStreamingApi) => Promise<void>
): Response {
  const res = streamSSE(c, run);
  res.headers.set("Content-Type", "text/event-stream; charset=utf-8");
  res.headers.set("Cache-Control", "no-cache, no-transform");
  res.headers.set("X-Accel-Buffering", "no");
  return res;
}

/** One `event:` + JSON `data:` frame, the shape every stream here sends. */
export function sendEvent(
  stream: SSEStreamingApi,
  event: string,
  data: unknown
): Promise<void> {
  return stream.writeSSE({ event, data: JSON.stringify(data) });
}

/**
 * Poll `read` every `intervalMs` and push each changed snapshot, until the
 * client leaves, `read` says stop, or `maxDurationMs` passes (the client's
 * EventSource reconnects, which also releases sockets held by vanished tabs).
 * The loop the run streams share.
 */
export async function pollSnapshots<T>(
  stream: SSEStreamingApi,
  opts: {
    intervalMs: number;
    maxDurationMs: number;
    // `undefined` ends the stream after the caller has sent its own event.
    read: () => Promise<{ snapshot: T; done: boolean } | undefined>;
    logLabel: string;
  }
): Promise<void> {
  const startedAt = Date.now();
  let lastSerialized = "";
  // The wait between polls ends early when the client leaves, so a departed
  // tab stops the loop now rather than one interval later.
  let wake = () => {};
  stream.onAbort(() => wake());
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stream.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  while (!stream.aborted && !stream.closed) {
    if (Date.now() - startedAt > opts.maxDurationMs) {
      await sendEvent(stream, "timeout", { reason: "max-duration" });
      return;
    }
    let result: Awaited<ReturnType<typeof opts.read>>;
    try {
      result = await opts.read();
    } catch (err) {
      // Surface transient DB errors as an `error` event and stop. Without this
      // the stream closes with no signal and the browser's EventSource
      // reconnects straight into the same failure. Generic message; the real
      // error is logged here.
      console.error(`${opts.logLabel} failed:`, err);
      await sendEvent(stream, "error", { message: "snapshot failed" });
      return;
    }
    if (!result) return;
    // Diff suppression: only emit when the snapshot actually changed.
    const serialized = JSON.stringify(result.snapshot);
    if (serialized !== lastSerialized) {
      await sendEvent(stream, "snapshot", result.snapshot);
      lastSerialized = serialized;
    }
    if (result.done) return;
    await sleep(opts.intervalMs);
  }
}

/**
 * A push stream fed from callbacks (SSH output, a WebSocket): the log and
 * mail streams. Owns what both need so neither can get it wrong:
 *
 * - Frames are written strictly one after another through a promise chain, so
 *   callbacks can `send` without awaiting and order is still kept.
 * - `close()` stops accepting frames, but `done` resolves only after every
 *   frame queued before it has been written. The route awaits `done`, and
 *   streamSSE closes the stream when the route returns — so the final frame
 *   (`close`, `stream-error`, `timeout`), the one the client acts on, is never
 *   cut off.
 * - A heartbeat comment keeps proxies and the EventSource from idling out,
 *   and at `maxDurationMs` a `timeout` event is sent and the channel closes
 *   (the client reconnects, releasing sockets held by vanished tabs).
 * - A client disconnect closes the channel. `onClose` runs exactly once, on
 *   any close, to stop the source.
 */
export function eventChannel(
  stream: SSEStreamingApi,
  opts: { maxDurationMs: number; heartbeatMs: number; onClose?: () => void }
) {
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let resolveDone = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  function enqueue(write: () => Promise<unknown>) {
    if (closed) return;
    // A failed write (client gone) must not stall the frames behind it.
    chain = chain.then(write).then(
      () => {},
      () => {}
    );
  }

  const channel = {
    get closed() {
      return closed;
    },
    /** Queue one `event:` + JSON `data:` frame. Ignored once closed. */
    send(event: string, data: unknown) {
      enqueue(() => sendEvent(stream, event, data));
    },
    /** Queue raw SSE text (a comment, a `retry:` line). Ignored once closed. */
    write(raw: string) {
      enqueue(() => stream.write(raw));
    },
    /** Stop accepting frames; `done` settles once the queue has drained. */
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(cap);
      try {
        opts.onClose?.();
      } catch {
        // the source is already stopped
      }
      void chain.then(resolveDone);
    },
    done,
  };

  const heartbeat = setInterval(
    () => channel.write(": ping\n\n"),
    opts.heartbeatMs
  );
  const cap = setTimeout(() => {
    channel.send("timeout", { reason: "max-duration" });
    channel.close();
  }, opts.maxDurationMs);

  stream.onAbort(() => channel.close());
  if (stream.aborted) channel.close();
  return channel;
}
