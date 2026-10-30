import { z } from "zod";
import { routeProjectGuard } from "@/lib/authz";
import { db } from "@/lib/db";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  getActiveRuns,
  getEnvironmentKpis,
  getEnvironmentRuns,
  getEnvironmentsLastActivity,
  getRunSnapshot,
} from "@/server/services/runs";
import { eventStream, pollSnapshots, sendEvent } from "@/server/sse";
import { query } from "@/server/validation";

// Run streams poll the DB rather than LISTEN/NOTIFY: the same snapshot feeds
// the initial render, and one source of truth beats juggling pub/sub.
const RUN_POLL_INTERVAL_MS = 1000;
const RUNNING_POLL_INTERVAL_MS = 2000;
// Cap a single SSE connection at 10 minutes to avoid leaking sockets when a
// browser silently disappears. Clients reconnect via EventSource on close.
const MAX_DURATION_MS = 10 * 60 * 1000;

const environmentIdQuery = query(z.object({ environmentId: uuidSchema }));

export const runsRouter = sessionRouter()
  .get("/get-environments-last-activity", async (c) =>
    c.json(await getEnvironmentsLastActivity())
  )
  .get("/get-active-runs", async (c) => c.json(await getActiveRuns()))
  .get("/get-environment-runs", environmentIdQuery, async (c) =>
    c.json(await getEnvironmentRuns(c.req.valid("query").environmentId))
  )
  .get("/get-run-snapshot", query(z.object({ runId: uuidSchema })), async (c) =>
    c.json(await getRunSnapshot(c.req.valid("query").runId))
  )
  .get("/get-environment-kpis", environmentIdQuery, async (c) =>
    c.json(await getEnvironmentKpis(c.req.valid("query").environmentId))
  )
  /**
   * The global running-runs list as SSE (ported from
   * app/api/runs/running/stream). Registered before `/:id/stream` so "running"
   * is never read as a run id. The service scopes the list to the caller's
   * projects; the session router has already authenticated.
   */
  .get("/running/stream", (c) =>
    eventStream(c, (stream) =>
      pollSnapshots(stream, {
        intervalMs: RUNNING_POLL_INTERVAL_MS,
        maxDurationMs: MAX_DURATION_MS,
        logLabel: "running-runs stream",
        read: async () => ({ snapshot: await getActiveRuns(), done: false }),
      })
    )
  )
  /**
   * One run's progress as SSE (ported from app/api/runs/[id]/stream). Ends
   * once the run leaves `started`.
   */
  .get("/:id/stream", async (c) => {
    const id = c.req.param("id");
    // Authorize against the run's project before opening the stream. A
    // malformed or unknown id is a 404, same as a run in a project the caller
    // can't see.
    const owner = uuidSchema.safeParse(id).success
      ? await db.query.runs.findFirst({
          where: { id },
          columns: { environmentId: true },
        })
      : undefined;
    const guard = await routeProjectGuard(
      { environmentId: owner?.environmentId ?? "" },
      { project: ["read"] }
    );
    if (!guard.ok) return guard.response;

    return eventStream(c, (stream) =>
      pollSnapshots(stream, {
        intervalMs: RUN_POLL_INTERVAL_MS,
        maxDurationMs: MAX_DURATION_MS,
        logLabel: "run stream snapshot",
        read: async () => {
          const run = await getRunSnapshot(id);
          if (!run) {
            await sendEvent(stream, "not-found", { id });
            return undefined;
          }
          return { snapshot: run, done: run.status !== "started" };
        },
      })
    );
  });
