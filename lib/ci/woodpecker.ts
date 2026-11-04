import {
  type CiProvider,
  CiProviderError,
  type CiRepo,
  type RepoSettings,
} from "@/lib/ci/types";

type WoodpeckerRepo = {
  id?: number | null;
  full_name: string;
  forge_remote_id: string;
  active?: boolean;
};

function toCiRepo(repo: WoodpeckerRepo): CiRepo {
  return {
    ciRepoId: repo.id ? String(repo.id) : "",
    fullName: repo.full_name,
    forgeRemoteId: repo.forge_remote_id,
    active: repo.active === true,
  };
}

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
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      // The underlying error is dropped on purpose: it could echo the request.
      throw new CiProviderError(`Woodpecker ${method} ${path} unreachable`, 0);
    }
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
      if (
        !(error instanceof CiProviderError) ||
        error.status === 0 ||
        error.status === 401 ||
        error.status === 403
      ) {
        throw error;
      }
      // Already active: Woodpecker refuses, so reuse the existing repo.
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

  return {
    listRepos,
    activateRepo,
    updateRepoSettings,
    upsertRepoSecret,
  };
}
