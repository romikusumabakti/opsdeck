import { ciFetch } from "@/lib/ci/http";
import { CiProviderError } from "@/lib/ci/types";

const API = "https://api.bitbucket.org/2.0/repositories";

export type BitbucketAuth = { username: string; token: string };

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_DETAIL = 300;

function assertRepo(repoFullName: string): void {
  if (
    !REPO_PATTERN.test(repoFullName) ||
    repoFullName.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Invalid Bitbucket repository name");
  }
}

// A "." or ".." segment ("..", "a/../b") is no git branch, and in a URL it
// can collapse into another path, so it is refused like control characters.
function assertBranch(branch: string): void {
  if (
    branch === "" ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    /[\s\u0000-\u001f\u007f]/.test(branch) ||
    branch.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Invalid branch name for a Bitbucket commit");
  }
}

function assertCommitInput(path: string, branch: string): void {
  if (
    path === "" ||
    path === "message" ||
    path === "branch" ||
    path.startsWith("/") ||
    path.split("/").includes("..")
  ) {
    throw new Error("Invalid file path for a Bitbucket commit");
  }
  assertBranch(branch);
}

async function request(
  auth: BitbucketAuth,
  method: string,
  repoFullName: string,
  suffix: string,
  body?: FormData,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const label = `Bitbucket ${method} ${repoFullName}${suffix}`;
  const res = await ciFetch(
    label,
    `${API}/${repoFullName}${suffix}`,
    {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.token}`).toString("base64")}`,
      },
      body,
    },
    fetchImpl
  );
  if (!res.ok) {
    let detail = "";
    try {
      const json = (await res.json()) as { error?: { message?: string } };
      detail = json.error?.message
        ? `: ${json.error.message.slice(0, MAX_DETAIL)}`
        : "";
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
  assertRepo(repoFullName);
  assertCommitInput(path, branch);
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

/** True when the branch exists, false on 404; any other failure throws. */
export async function branchExists(
  auth: BitbucketAuth,
  repoFullName: string,
  branch: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  assertRepo(repoFullName);
  assertBranch(branch);
  try {
    await request(
      auth,
      "GET",
      repoFullName,
      `/refs/branches/${encodeURIComponent(branch)}`,
      undefined,
      fetchImpl
    );
    return true;
  } catch (error) {
    if (error instanceof CiProviderError && error.status === 404) return false;
    throw error;
  }
}
