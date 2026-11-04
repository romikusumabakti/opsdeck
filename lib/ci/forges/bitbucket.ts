import { CiProviderError } from "@/lib/ci/types";

const API = "https://api.bitbucket.org/2.0/repositories";

export type BitbucketAuth = { username: string; token: string };

async function request(
  auth: BitbucketAuth,
  method: string,
  repoFullName: string,
  suffix: string,
  body?: FormData,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const label = `Bitbucket ${method} ${repoFullName}${suffix}`;
  let res: Response;
  try {
    res = await fetchImpl(`${API}/${repoFullName}${suffix}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.token}`).toString("base64")}`,
      },
      body,
    });
  } catch {
    // The underlying error is dropped on purpose: it could echo the request.
    throw new CiProviderError(`${label} unreachable`, 0);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const json = (await res.json()) as { error?: { message?: string } };
      detail = json.error?.message ? `: ${json.error.message}` : "";
    } catch {
      // Non-JSON error body: the status alone is reported.
    }
    throw new CiProviderError(
      `${label} failed with ${res.status}${detail}`,
      res.status
    );
  }
  return res;
}

/** Commits one file to a branch; returns the new commit sha. */
export async function commitFile(
  auth: BitbucketAuth,
  repoFullName: string,
  branch: string,
  path: string,
  content: string,
  message: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ sha: string }> {
  const form = new FormData();
  form.set(path, new Blob([content], { type: "text/plain" }), path);
  form.set("message", message);
  form.set("branch", branch);
  const res = await request(
    auth,
    "POST",
    repoFullName,
    "/src",
    form,
    fetchImpl
  );
  const sha = res.headers.get("location")?.match(/\/commit\/([^/?#]+)$/)?.[1];
  if (!sha) {
    throw new CiProviderError(
      `Bitbucket POST ${repoFullName}/src returned no commit sha`,
      res.status
    );
  }
  return { sha };
}

export async function getDefaultBranch(
  auth: BitbucketAuth,
  repoFullName: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const res = await request(
    auth,
    "GET",
    repoFullName,
    "",
    undefined,
    fetchImpl
  );
  const name = ((await res.json()) as { mainbranch?: { name?: string } })
    .mainbranch?.name;
  if (!name) {
    throw new CiProviderError(
      `Bitbucket GET ${repoFullName} has no main branch`,
      res.status
    );
  }
  return name;
}
