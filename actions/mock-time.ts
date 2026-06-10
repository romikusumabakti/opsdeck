"use server";

import { inngest } from "@/inngest/client";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { type ProjectWithServers, tasks } from "@/lib/db/schema";
import { loadProjectWithServers } from "@/lib/projects";
import { executeRemoteCommand } from "@/lib/ssh";
import { createTask } from "@/lib/task-progress";
import {
  isoDateTimeSchema,
  isoDurationSchema,
  projectIdSchema,
} from "@/lib/validation";

export type ClockState = {
  now: string;
  mocked: boolean;
  frozen: boolean;
};

export type LegacyResult =
  | { success: true; mode: "legacy"; taskId: string }
  | { success: false; mode: "legacy"; error: string };

export type ApiResult<T = ClockState> =
  | { success: true; data: T }
  | { success: false; error: string };

// 30s leaves headroom for endpoints that do non-trivial work on receiving the
// new time (e.g. restarting workers). The previous 5s timed out under normal
// load even when the underlying request would have succeeded.
const API_TIMEOUT_MS = 30_000;

// Validate + auth + load the project for a mock-time action in one place. The
// API URL/key come from the loaded (trusted) DB record, never the client — so
// the server-side `fetch` below can't be redirected to an attacker URL (SSRF).
async function requireProject(
  projectId: string
): Promise<
  | { ok: true; project: ProjectWithServers; userId: string }
  | { ok: false; error: string }
> {
  const session = await requireSession();
  if (!projectIdSchema.safeParse(projectId).success) {
    return { ok: false, error: "Invalid project id" };
  }
  const project = await loadProjectWithServers(projectId);
  if (!project) return { ok: false, error: "Project not found" };
  return { ok: true, project, userId: session.user.id };
}

// Node's fetch retries every resolved address (Happy Eyeballs). When all fail
// it surfaces an AggregateError under `cause` whose `errors[]` each carry the
// real reason (ETIMEDOUT, ECONNREFUSED, ENETUNREACH...). Pull the most useful
// one for the toast.
function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const errors = (
        cause as { errors?: Array<{ code?: string; message?: string }> }
      ).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0];
        return first.code
          ? `${first.code}: ${first.message ?? ""}`
          : (first.message ?? err.message);
      }
      const code = (cause as { code?: string }).code;
      if (code) return code;
    }
    return err.message || err.name;
  }
  return String(err);
}

// Parses RFC 7807 problem+json bodies returned by the clock API. Falls back to
// status text when the body is missing or non-JSON.
async function describeHttpError(response: Response): Promise<string> {
  const statusLine = `${response.status} ${response.statusText}`.trim();
  try {
    const body = (await response.json()) as {
      title?: string;
      detail?: string;
    };
    const parts = [body.title, body.detail].filter(Boolean);
    if (parts.length > 0) return `${statusLine} — ${parts.join(": ")}`;
  } catch {
    // ignore
  }
  return statusLine;
}

function clockUrl(project: ProjectWithServers): string | null {
  const url = project.backendMockTimeApiUrl?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

function isClockState(value: unknown): value is ClockState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.now === "string" &&
    typeof v.mocked === "boolean" &&
    typeof v.frozen === "boolean"
  );
}

type ClockRequest = {
  method: "GET" | "POST" | "DELETE";
  path?: string;
  body?: unknown;
};

async function clockFetch(
  project: ProjectWithServers,
  req: ClockRequest
): Promise<Response> {
  const base = clockUrl(project);
  if (!base) throw new Error("Project has no mock-time API URL configured");
  const url = req.path ? `${base}${req.path}` : base;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = project.backendMockTimeApiKey?.trim();
  if (apiKey) headers["X-Api-Key"] = apiKey;
  const init: RequestInit = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  };
  if (req.body !== undefined) init.body = JSON.stringify(req.body);
  return fetch(url, init);
}

async function recordAudit(
  project: ProjectWithServers,
  userId: string,
  runAt: Date,
  description: string,
  status: "success" | "failed",
  errorMessage?: string
) {
  try {
    await db.insert(tasks).values({
      projectId: project.id,
      userId,
      description,
      status,
      runAt,
      completedAt: new Date(),
      errorMessage: errorMessage ?? null,
    });
  } catch (err) {
    console.error("mock-time: failed to record audit task", err);
  }
}

async function callMutating(
  project: ProjectWithServers,
  userId: string,
  req: ClockRequest,
  auditDescription: string,
  parseBody: boolean
): Promise<ApiResult<ClockState | null>> {
  const runAt = new Date();
  let response: Response;
  try {
    response = await clockFetch(project, req);
  } catch (err) {
    const error = describeFetchError(err);
    await recordAudit(
      project,
      userId,
      runAt,
      auditDescription,
      "failed",
      error
    );
    return { success: false, error };
  }
  if (!response.ok) {
    const error = await describeHttpError(response);
    await recordAudit(
      project,
      userId,
      runAt,
      auditDescription,
      "failed",
      error
    );
    return { success: false, error };
  }

  let data: ClockState | null = null;
  if (parseBody) {
    try {
      const parsed = await response.json();
      if (!isClockState(parsed)) {
        const error = "Unexpected response shape from clock API";
        await recordAudit(
          project,
          userId,
          runAt,
          auditDescription,
          "failed",
          error
        );
        return { success: false, error };
      }
      data = parsed;
    } catch (err) {
      const error = `Invalid JSON from clock API: ${describeFetchError(err)}`;
      await recordAudit(
        project,
        userId,
        runAt,
        auditDescription,
        "failed",
        error
      );
      return { success: false, error };
    }
  }

  await recordAudit(project, userId, runAt, auditDescription, "success");
  return { success: true, data };
}

export async function getClockState(
  projectId: string
): Promise<ApiResult<ClockState>> {
  const ctx = await requireProject(projectId);
  if (!ctx.ok) return { success: false, error: ctx.error };
  let response: Response;
  try {
    response = await clockFetch(ctx.project, { method: "GET" });
  } catch (err) {
    return { success: false, error: describeFetchError(err) };
  }
  if (!response.ok) {
    return { success: false, error: await describeHttpError(response) };
  }
  try {
    const parsed = await response.json();
    if (!isClockState(parsed)) {
      return {
        success: false,
        error: "Unexpected response shape from clock API",
      };
    }
    return { success: true, data: parsed };
  } catch (err) {
    return {
      success: false,
      error: `Invalid JSON from clock API: ${describeFetchError(err)}`,
    };
  }
}

export async function travelClock(
  projectId: string,
  target: string
): Promise<ApiResult<ClockState>> {
  const ctx = await requireProject(projectId);
  if (!ctx.ok) return { success: false, error: ctx.error };
  if (!isoDateTimeSchema.safeParse(target).success) {
    return { success: false, error: "Invalid target timestamp" };
  }
  const result = await callMutating(
    ctx.project,
    ctx.userId,
    { method: "POST", path: "/travel", body: { target } },
    `Mock time: travel to ${target}`,
    true
  );
  if (!result.success) return result;
  return { success: true, data: result.data as ClockState };
}

export async function freezeClock(
  projectId: string,
  at: string | null
): Promise<ApiResult<ClockState>> {
  const ctx = await requireProject(projectId);
  if (!ctx.ok) return { success: false, error: ctx.error };
  if (at !== null && !isoDateTimeSchema.safeParse(at).success) {
    return { success: false, error: "Invalid freeze timestamp" };
  }
  const body = at ? { at } : undefined;
  const description = at
    ? `Mock time: freeze at ${at}`
    : "Mock time: freeze at current time";
  const result = await callMutating(
    ctx.project,
    ctx.userId,
    { method: "POST", path: "/freeze", body },
    description,
    true
  );
  if (!result.success) return result;
  return { success: true, data: result.data as ClockState };
}

export async function advanceClock(
  projectId: string,
  duration: string
): Promise<ApiResult<ClockState>> {
  const ctx = await requireProject(projectId);
  if (!ctx.ok) return { success: false, error: ctx.error };
  if (!isoDurationSchema.safeParse(duration).success) {
    return { success: false, error: "Invalid duration" };
  }
  const result = await callMutating(
    ctx.project,
    ctx.userId,
    { method: "POST", path: "/advance", body: { duration } },
    `Mock time: advance by ${duration}`,
    true
  );
  if (!result.success) return result;
  return { success: true, data: result.data as ClockState };
}

export async function resetClock(projectId: string): Promise<ApiResult<null>> {
  const ctx = await requireProject(projectId);
  if (!ctx.ok) return { success: false, error: ctx.error };
  // DELETE /clock returns 204 No Content — don't try to parse a body.
  const result = await callMutating(
    ctx.project,
    ctx.userId,
    { method: "DELETE" },
    "Mock time: reset to real time",
    false
  );
  if (!result.success) return result;
  return { success: true, data: null };
}

export async function mockProjectTimeLegacy(
  projectId: string,
  mockedAt: string
): Promise<LegacyResult> {
  const ctx = await requireProject(projectId);
  if (!ctx.ok) return { success: false, mode: "legacy", error: ctx.error };
  if (!isoDateTimeSchema.safeParse(mockedAt).success) {
    return { success: false, mode: "legacy", error: "Invalid timestamp" };
  }
  try {
    const taskId = await createTask({
      projectId: ctx.project.id,
      userId: ctx.userId,
      description: `Mock time to ${mockedAt} (legacy)`,
    });
    await inngest.send({
      name: "project/mock-time.legacy",
      data: { projectId: ctx.project.id, mockedAt, taskId },
    });
    return { success: true, mode: "legacy", taskId };
  } catch (error) {
    return { success: false, mode: "legacy", error: describeFetchError(error) };
  }
}

function legacyCredentials(project: ProjectWithServers) {
  return {
    host: project.backendServer.host,
    username: project.backendServer.username,
    password: project.backendServer.password,
  };
}

// Parse the ISO 8601 duration subset the UI emits: optional `-`, P[n]D, then
// optional T[n]H[n]M[n]S. Returns the duration in milliseconds, or null if the
// string doesn't match.
function parseIsoDurationMs(duration: string): number | null {
  const match = duration.match(
    /^(-?)P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
  );
  if (!match) return null;
  const [, sign, d, h, m, s] = match;
  if (!d && !h && !m && !s) return null;
  const totalSeconds =
    Number(d ?? 0) * 86400 +
    Number(h ?? 0) * 3600 +
    Number(m ?? 0) * 60 +
    Number(s ?? 0);
  const ms = totalSeconds * 1000;
  return sign === "-" ? -ms : ms;
}

// Best-effort drift threshold: a remote clock that disagrees with the panel's
// wall clock by more than this is assumed to have been previously mocked.
// Legitimate NTP-synced hosts should drift by milliseconds; 5 minutes is well
// above that.
const LEGACY_MOCK_DRIFT_THRESHOLD_MS = 5 * 60 * 1000;

export async function getClockStateLegacy(
  projectId: string
): Promise<ApiResult<ClockState>> {
  const ctx = await requireProject(projectId);
  if (!ctx.ok) return { success: false, error: ctx.error };
  try {
    const stdout = await executeRemoteCommand(
      legacyCredentials(ctx.project),
      "date -u +%Y-%m-%dT%H:%M:%SZ"
    );
    const now = stdout.trim();
    const remoteMs = new Date(now).getTime();
    if (Number.isNaN(remoteMs)) {
      return {
        success: false,
        error: `Invalid date output from server: ${now}`,
      };
    }
    const drift = Math.abs(Date.now() - remoteMs);
    return {
      success: true,
      data: {
        now,
        mocked: drift > LEGACY_MOCK_DRIFT_THRESHOLD_MS,
        frozen: false,
      },
    };
  } catch (err) {
    return { success: false, error: describeFetchError(err) };
  }
}

export async function advanceClockLegacy(
  projectId: string,
  duration: string
): Promise<LegacyResult> {
  const ctx = await requireProject(projectId);
  if (!ctx.ok) return { success: false, mode: "legacy", error: ctx.error };
  const offsetMs = parseIsoDurationMs(duration);
  if (offsetMs === null) {
    return {
      success: false,
      mode: "legacy",
      error: `Invalid duration: ${duration}`,
    };
  }
  // Anchor on the backend server's *current* clock so an advance applied to an
  // already-mocked time shifts from there, not from the panel's wall clock.
  // Falls back to panel time if the read fails — surface as audit failure.
  let baseMs: number;
  try {
    const stdout = await executeRemoteCommand(
      legacyCredentials(ctx.project),
      "date -u +%Y-%m-%dT%H:%M:%SZ"
    );
    const parsed = new Date(stdout.trim()).getTime();
    baseMs = Number.isNaN(parsed) ? Date.now() : parsed;
  } catch (err) {
    return { success: false, mode: "legacy", error: describeFetchError(err) };
  }
  const targetIso = new Date(baseMs + offsetMs).toISOString();
  try {
    const taskId = await createTask({
      projectId: ctx.project.id,
      userId: ctx.userId,
      description: `Advance clock by ${duration} → ${targetIso} (legacy)`,
    });
    await inngest.send({
      name: "project/mock-time.legacy",
      data: { projectId: ctx.project.id, mockedAt: targetIso, taskId },
    });
    return { success: true, mode: "legacy", taskId };
  } catch (err) {
    return { success: false, mode: "legacy", error: describeFetchError(err) };
  }
}

export async function resetClockLegacy(
  projectId: string
): Promise<LegacyResult> {
  const ctx = await requireProject(projectId);
  if (!ctx.ok) return { success: false, mode: "legacy", error: ctx.error };
  try {
    const taskId = await createTask({
      projectId: ctx.project.id,
      userId: ctx.userId,
      description: "Reset clock to real time (legacy)",
    });
    await inngest.send({
      name: "project/mock-time.reset-legacy",
      data: { projectId: ctx.project.id, taskId },
    });
    return { success: true, mode: "legacy", taskId };
  } catch (err) {
    return { success: false, mode: "legacy", error: describeFetchError(err) };
  }
}
