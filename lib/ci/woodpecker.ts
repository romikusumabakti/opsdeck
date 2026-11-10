import { ciFetch } from "@/lib/ci/http";
import {
  type ActivePipeline,
  type CiProvider,
  CiProviderError,
  type CiRepo,
  type PipelineActors,
  type RepoSettings,
} from "@/lib/ci/types";

type WoodpeckerRepo = {
  id?: number | null;
  full_name: string;
  forge_remote_id: string;
  active?: boolean;
  default_branch?: string | null;
};

function toCiRepo(repo: WoodpeckerRepo): CiRepo {
  return {
    ciRepoId: repo.id ? String(repo.id) : "",
    fullName: repo.full_name,
    forgeRemoteId: repo.forge_remote_id,
    active: repo.active === true,
    ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {}),
  };
}

type WoodpeckerPipeline = {
  sender?: unknown;
  author_email?: unknown;
  message?: unknown;
};

type WoodpeckerPipelineSummary = {
  number?: unknown;
  branch?: unknown;
  status?: unknown;
};

const ACTIVE_STATUSES = new Set(["pending", "running"]);
// Woodpecker caps a page at 50; an active pipeline is among the latest few.
const ACTIVE_PIPELINES_PAGE = 20;

const PIPELINE_PATH =
  /^\/repos\/([1-9][0-9]{0,15})\/pipeline\/([1-9][0-9]{0,15})$/;

/**
 * The pipeline number in a Woodpecker pipeline URL (CI_PIPELINE_URL, e.g.
 * `https://ci.example/repos/2/pipeline/7`), only when it belongs to the repo
 * `ciRepoId`; null for anything else. The URL comes from the notification, so
 * it must not choose which repo's pipeline is read. The host is not compared:
 * the connection's base URL is often an internal address.
 */
export function parsePipelineNumber(
  url: string | null | undefined,
  ciRepoId: string | null | undefined
): number | null {
  if (!url || !ciRepoId) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.search || parsed.hash) return null;
  const match = PIPELINE_PATH.exec(parsed.pathname);
  if (!match || match[1] !== ciRepoId) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) ? number : null;
}

/**
 * Checks that the API token works: Woodpecker's current-user call. Throws
 * CiProviderError (status 0 when unreachable) like every provider call.
 */
export async function verifyWoodpeckerToken(
  baseUrl: string,
  apiToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const res = await ciFetch(
    "Woodpecker GET /api/user",
    `${baseUrl.replace(/\/+$/, "")}/api/user`,
    { method: "GET", headers: { Authorization: `Bearer ${apiToken}` } },
    fetchImpl
  );
  if (!res.ok) {
    throw new CiProviderError(
      `Woodpecker GET /api/user failed with ${res.status}`,
      res.status
    );
  }
}

const orNull = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : null;

export function createWoodpeckerProvider(
  baseUrl: string,
  apiToken: string,
  fetchImpl: typeof fetch = fetch
): CiProvider {
  const root = baseUrl.replace(/\/+$/, "");

  async function request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> {
    const res = await ciFetch(
      `Woodpecker ${method} ${path}`,
      `${root}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      fetchImpl
    );
    if (!res.ok) {
      throw new CiProviderError(
        `Woodpecker ${method} ${path} failed with ${res.status}`,
        res.status
      );
    }
    return res;
  }

  async function listRepos(): Promise<CiRepo[]> {
    const res = await request("GET", "/api/user/repos?all=true");
    return ((await res.json()) as WoodpeckerRepo[]).map(toCiRepo);
  }

  async function activateRepo(forgeRemoteId: string): Promise<CiRepo> {
    try {
      const res = await request(
        "POST",
        `/api/repos?forge_remote_id=${encodeURIComponent(forgeRemoteId)}`
      );
      return toCiRepo((await res.json()) as WoodpeckerRepo);
    } catch (error) {
      // Already active: Woodpecker answers 409, so reuse the existing repo.
      // Any other failure is real and reported as is.
      if (!(error instanceof CiProviderError) || error.status !== 409) {
        throw error;
      }
      const existing = (await listRepos()).find(
        (r) => r.forgeRemoteId === forgeRemoteId && r.active
      );
      if (!existing) throw error;
      const res = await request(
        "GET",
        `/api/repos/lookup/${existing.fullName}`
      );
      return toCiRepo((await res.json()) as WoodpeckerRepo);
    }
  }

  async function updateRepoSettings(
    ciRepoId: string,
    settings: RepoSettings
  ): Promise<void> {
    await request("PATCH", `/api/repos/${encodeURIComponent(ciRepoId)}`, {
      timeout: settings.timeoutMinutes,
      cancel_previous_pipeline_events: settings.cancelPreviousOnPush
        ? ["push"]
        : [],
      config_extension_endpoint: settings.configExtensionEndpoint ?? "",
      config_extension_exclusive: false,
      config_extension_netrc: false,
    });
  }

  async function upsertRepoSecret(
    ciRepoId: string,
    name: string,
    value: string,
    events: ("push" | "manual")[]
  ): Promise<void> {
    const base = `/api/repos/${encodeURIComponent(ciRepoId)}/secrets`;
    const secret = `${base}/${encodeURIComponent(name)}`;
    let exists = true;
    try {
      await request("GET", secret);
    } catch (error) {
      if (!(error instanceof CiProviderError) || error.status !== 404) {
        throw error;
      }
      exists = false;
    }
    if (exists) await request("PATCH", secret, { value, events });
    else await request("POST", base, { name, value, events });
  }

  async function getPipeline(
    ciRepoId: string,
    number: number
  ): Promise<PipelineActors> {
    let res: Response;
    try {
      res = await request(
        "GET",
        `/api/repos/${encodeURIComponent(ciRepoId)}/pipelines/${number}`
      );
    } catch (error) {
      if (error instanceof CiProviderError && error.status === 404) {
        return { sender: null, authorEmail: null, message: null };
      }
      throw error;
    }
    const pipeline = (await res.json()) as WoodpeckerPipeline | null;
    return {
      sender: orNull(pipeline?.sender),
      authorEmail: orNull(pipeline?.author_email),
      message: orNull(pipeline?.message),
    };
  }

  async function triggerPipeline(
    ciRepoId: string,
    branch: string
  ): Promise<{ number: number }> {
    const res = await request(
      "POST",
      `/api/repos/${encodeURIComponent(ciRepoId)}/pipelines`,
      { branch, variables: {} }
    );
    const pipeline = (await res.json()) as { number?: unknown } | null;
    if (!Number.isSafeInteger(pipeline?.number)) {
      throw new CiProviderError(
        "Woodpecker POST /pipelines answered without a pipeline number",
        502
      );
    }
    return { number: pipeline?.number as number };
  }

  async function listActivePipelines(
    ciRepoId: string,
    branch: string
  ): Promise<ActivePipeline[]> {
    const repo = encodeURIComponent(ciRepoId);
    const query = new URLSearchParams({
      branch,
      perPage: String(ACTIVE_PIPELINES_PAGE),
    });
    const res = await request("GET", `/api/repos/${repo}/pipelines?${query}`);
    const pipelines = (await res.json()) as unknown;
    if (!Array.isArray(pipelines)) return [];
    // Filtered here too: the branch filter is the server's, the status filter
    // takes one status only.
    return (pipelines as WoodpeckerPipelineSummary[])
      .filter(
        (p): p is WoodpeckerPipelineSummary & { number: number } =>
          Number.isSafeInteger(p?.number) &&
          (p.number as number) > 0 &&
          p.branch === branch &&
          typeof p.status === "string" &&
          ACTIVE_STATUSES.has(p.status)
      )
      .sort((a, b) => b.number - a.number)
      .map((p) => ({
        number: p.number,
        // The same URL Woodpecker hands pipelines as CI_PIPELINE_URL.
        url: `${root}/repos/${repo}/pipeline/${p.number}`,
      }));
  }

  return {
    listActivePipelines,
    listRepos,
    activateRepo,
    updateRepoSettings,
    upsertRepoSecret,
    getPipeline,
    triggerPipeline,
  };
}
