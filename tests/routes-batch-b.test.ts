import { describe, expect, it, vi } from "vitest";
import { app, createBaseApp } from "@/server/app";
import {
  eventChannel,
  eventStream,
  pollSnapshots,
  sendEvent,
} from "@/server/sse";

// Same rule as routes-batch-a: no cookie anywhere, so every gated route must
// stop at its session check. A route that reached Postgres first would fail on
// the dummy DATABASE_URL (500) instead of answering 401.

const ID = "0190a8e2-7b1c-7cc2-9d3e-3c1f2a4b5c6d";
const q = (value: unknown) => `q=${encodeURIComponent(JSON.stringify(value))}`;
const SOURCE = { kind: "sftp", serverId: ID };

function post(path: string, body: unknown = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// One read and one write per mounted module (runs has no write).
const GATED: [method: "GET" | "POST", path: string][] = [
  ["GET", "/api/environments/list-environments"],
  ["POST", "/api/environments/create-environment"],
  ["GET", `/api/environments/resolve?projectKey=CMEM&envSlug=prod`],
  ["GET", `/api/services/get-all-service-statuses?environmentId=${ID}`],
  ["POST", "/api/services/control-service"],
  ["GET", "/api/runs/get-active-runs"],
  ["GET", `/api/runs/get-run-snapshot?runId=${ID}`],
  ["GET", `/api/backups/get-backup-list?environmentId=${ID}`],
  ["POST", "/api/backups/create-database-backup"],
  ["GET", `/api/databases/get-database-list?environmentId=${ID}`],
  ["POST", "/api/databases/create-database"],
  ["GET", `/api/mail/get-mail?environmentId=${ID}&messageId=abc`],
  ["GET", `/api/mail/configured?environmentId=${ID}`],
  ["POST", "/api/mail/delete-mail"],
  ["GET", `/api/mailpit-settings/get-mailpit-settings?environmentId=${ID}`],
  ["POST", "/api/mailpit-settings/save-mailpit-settings"],
  ["GET", `/api/mock-time/get-clock-state?environmentId=${ID}`],
  ["POST", "/api/mock-time/travel-clock"],
  ["GET", `/api/test-runs/list-issue-test-runs?issueId=${ID}`],
  ["POST", "/api/test-runs/record-test-run"],
  ["GET", "/api/servers/get-servers"],
  ["POST", "/api/servers/create-server"],
  ["GET", "/api/s3-connections/get-s3-connections"],
  ["POST", "/api/s3-connections/create-s3-connection"],
  ["GET", `/api/explorer/list-entries?${q({ source: SOURCE, path: "" })}`],
  ["POST", "/api/explorer/create-folder"],
  ["GET", "/api/tunnels/get-tunnels"],
  ["POST", "/api/tunnels/create-tunnel"],
  ["GET", "/api/integrations/jira/get-jira-connections"],
  ["POST", "/api/integrations/jira/create-jira-connection"],
  // Handlers ported from app/api keep their paths.
  ["GET", `/api/runs/${ID}/stream`],
  ["GET", "/api/runs/running/stream"],
  ["GET", `/api/environments/${ID}/mail/events`],
  ["GET", `/api/environments/${ID}/mail/abc/raw`],
  ["GET", `/api/environments/${ID}/mail/abc/part/1`],
  ["GET", `/api/environments/${ID}/services/backend/logs/stream`],
  [
    "GET",
    `/api/explorer/download?source=${encodeURIComponent(JSON.stringify(SOURCE))}&path=a`,
  ],
  [
    "GET",
    `/api/explorer/archive?source=${encodeURIComponent(JSON.stringify(SOURCE))}`,
  ],
  ["POST", "/api/explorer/upload"],
  ["POST", "/api/terminal/ticket"],
];

describe("gated routes answer 401 without a session", () => {
  it.each(GATED)("%s %s", async (method, path) => {
    const res = method === "GET" ? await app.request(path) : await post(path);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  // The SSE handlers authenticate before opening a stream: a signed-out
  // EventSource gets a plain 401, never a text/event-stream.
  it("GET /api/runs/:id/stream does not open a stream", async () => {
    const res = await app.request(`/api/runs/${ID}/stream`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).not.toMatch(/event-stream/);
  });
});

describe("public routes", () => {
  // The webhook authenticates by its path token, not a session. A token too
  // short to be one is a 404 before any lookup — what the Next handler sent.
  it("POST /api/jira/webhook/:token rejects an unknown token with 404", async () => {
    const res = await post("/api/jira/webhook/bad-token", {
      webhookEvent: "jira:issue_updated",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("GET /brand/icon.svg serves the favicon without a session", async () => {
    const res = await app.request("/brand/icon.svg?accent=blue");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await res.text()).toMatch(/^<svg/);
  });
});

describe("CSRF origin check", () => {
  // JSON is not a content type a plain HTML form can send, so the Jira
  // webhook (application/json, no Origin) is unaffected.
  it("does not check JSON requests", async () => {
    const res = await post("/api/jira/webhook/bad-token", {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("event streams", () => {
  // The run streams' loop, driven by a fake reader: three polls, the middle one
  // unchanged, the last one done.
  const probe = createBaseApp().get("/stream", (c) => {
    const snapshots = [{ n: 1 }, { n: 1 }, { n: 2 }];
    let i = 0;
    return eventStream(c, async (stream) => {
      await sendEvent(stream, "hello", { ok: true });
      await pollSnapshots(stream, {
        intervalMs: 1,
        maxDurationMs: 60_000,
        logLabel: "probe",
        read: async () => {
          const snapshot = snapshots[i++] ?? { n: 2 };
          return { snapshot, done: i >= snapshots.length };
        },
      });
    });
  });

  it("sends unbuffered SSE with the Next handlers' headers", async () => {
    const res = await probe.request("/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8"
    );
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("writes event frames and suppresses unchanged snapshots", async () => {
    const res = await probe.request("/stream");
    expect(await res.text()).toBe(
      [
        'event: hello\ndata: {"ok":true}\n\n',
        'event: snapshot\ndata: {"n":1}\n\n',
        'event: snapshot\ndata: {"n":2}\n\n',
      ].join("")
    );
  });

  it("ends with a timeout event at the duration cap", async () => {
    const capped = createBaseApp().get("/capped", (c) =>
      eventStream(c, (stream) =>
        pollSnapshots(stream, {
          intervalMs: 1,
          maxDurationMs: -1,
          logLabel: "probe",
          read: async () => ({ snapshot: 1, done: false }),
        })
      )
    );
    const res = await capped.request("/capped");
    expect(await res.text()).toBe(
      'event: timeout\ndata: {"reason":"max-duration"}\n\n'
    );
  });

  it("reports a failed read as a generic error event", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = createBaseApp().get("/failing", (c) =>
      eventStream(c, (stream) =>
        pollSnapshots(stream, {
          intervalMs: 1,
          maxDurationMs: 60_000,
          logLabel: "probe",
          read: async () => {
            throw new Error("connection refused at 10.0.0.5");
          },
        })
      )
    );
    const res = await failing.request("/failing");
    expect(await res.text()).toBe(
      'event: error\ndata: {"message":"snapshot failed"}\n\n'
    );
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

// The log and mail streams are event-driven: frames are queued from callbacks
// and the stream closes when the source ends. The final frame (`close`,
// `stream-error`, `timeout`) is the one the client acts on, so it must reach the
// body before the stream closes.
describe("event channels", () => {
  const LONG = 60_000;

  it("delivers every queued frame, in order, before closing", async () => {
    let onCloseCalls = 0;
    const probe = createBaseApp().get("/channel", (c) =>
      eventStream(c, async (stream) => {
        const channel = eventChannel(stream, {
          maxDurationMs: LONG,
          heartbeatMs: LONG,
          onClose: () => {
            onCloseCalls++;
          },
        });
        channel.write("retry: 10000\n\n");
        channel.send("lines", ["a", "b"]);
        channel.send("close", { code: 0 });
        channel.close();
        // Nothing after close is sent.
        channel.send("late", {});
        await channel.done;
      })
    );
    const res = await probe.request("/channel");
    expect(await res.text()).toBe(
      [
        "retry: 10000\n\n",
        'event: lines\ndata: ["a","b"]\n\n',
        'event: close\ndata: {"code":0}\n\n',
      ].join("")
    );
    expect(onCloseCalls).toBe(1);
  });

  it("sends heartbeats and a final timeout event at the cap", async () => {
    const probe = createBaseApp().get("/capped", (c) =>
      eventStream(c, async (stream) => {
        const channel = eventChannel(stream, {
          maxDurationMs: 40,
          heartbeatMs: 10,
        });
        await channel.done;
      })
    );
    const body = await (await probe.request("/capped")).text();
    expect(body).toContain(": ping\n\n");
    expect(
      body.endsWith('event: timeout\ndata: {"reason":"max-duration"}\n\n')
    ).toBe(true);
  });

  it("closes when the client goes away", async () => {
    let closed!: () => void;
    const sourceStopped = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const probe = createBaseApp().get("/abort", (c) =>
      eventStream(c, async (stream) => {
        const channel = eventChannel(stream, {
          maxDurationMs: LONG,
          heartbeatMs: LONG,
          onClose: closed,
        });
        channel.send("ready", {});
        await channel.done;
      })
    );
    const res = await probe.request("/abort");
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await sourceStopped;
  });
});

describe("snapshot polling", () => {
  // A long interval must not keep the loop (and its DB polling) alive after
  // the client disconnects.
  it("stops sleeping as soon as the client goes away", async () => {
    let reads = 0;
    let finished!: () => void;
    const loopEnded = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const probe = createBaseApp().get("/poll", (c) =>
      eventStream(c, async (stream) => {
        await pollSnapshots(stream, {
          intervalMs: 60_000,
          maxDurationMs: 600_000,
          logLabel: "probe",
          read: async () => ({ snapshot: ++reads, done: false }),
        });
        finished();
      })
    );
    const res = await probe.request("/poll");
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await loopEnded;
    expect(reads).toBe(1);
  }, 5_000);
});
