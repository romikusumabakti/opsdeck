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

/**
 * Checks that the credentials work: reads a repository the Panel commits to
 * (the access commits need) or, with none registered yet, the account itself.
 * Throws CiProviderError (status 0 when unreachable).
 */
export async function verifyBitbucketAuth(
  auth: BitbucketAuth,
  repoFullName: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (repoFullName !== null) {
    assertRepo(repoFullName);
    await request(auth, "GET", repoFullName, "", undefined, fetchImpl);
    return;
  }
  const res = await ciFetch(
    "Bitbucket GET /user",
    "https://api.bitbucket.org/2.0/user",
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.token}`).toString("base64")}`,
      },
    },
    fetchImpl
  );
  if (!res.ok) {
    throw new CiProviderError(
      `Bitbucket GET /user failed with ${res.status}`,
      res.status
    );
  }
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

const MAX_FILE_BYTES = 256 * 1024;
const DIR_PAGE_LENGTH = 100;
// A directory listing is paged; a repository this wide is no compose project.
const MAX_DIR_PAGES = 20;

// Each segment is encoded, the "/" between segments stays.
function encodePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== "")
    .map(encodeURIComponent)
    .join("/");
}

function assertReadPath(path: string): void {
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error("Invalid file path for a Bitbucket read");
  }
}

function srcSuffix(ref: string, path: string): string {
  assertBranch(ref);
  assertReadPath(path);
  const encoded = encodePath(path);
  return `/src/${encodePath(ref)}${encoded ? `/${encoded}` : ""}`;
}

/** Marks a file over the size limit, for callers that must fail closed. */
export const FILE_TOO_LARGE = Symbol("FILE_TOO_LARGE");

/**
 * Reads one file at a ref (branch, tag or commit) as text. Null on 404, and
 * null when the file is larger than 256 KiB (never a truncated file).
 */
export async function readRepoFile(
  auth: BitbucketAuth,
  repoFullName: string,
  ref: string,
  path: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const content = await readRepoFileOrLarge(
    auth,
    repoFullName,
    ref,
    path,
    fetchImpl
  );
  return content === FILE_TOO_LARGE ? null : content;
}

/** Like readRepoFile, but reports a too-large file as FILE_TOO_LARGE. */
export async function readRepoFileOrLarge(
  auth: BitbucketAuth,
  repoFullName: string,
  ref: string,
  path: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | typeof FILE_TOO_LARGE | null> {
  assertRepo(repoFullName);
  let res: Response;
  try {
    res = await request(
      auth,
      "GET",
      repoFullName,
      srcSuffix(ref, path),
      undefined,
      fetchImpl
    );
  } catch (error) {
    if (error instanceof CiProviderError && error.status === 404) return null;
    throw error;
  }
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_FILE_BYTES) {
    await res.body?.cancel();
    return FILE_TOO_LARGE;
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FILE_BYTES) {
      await reader.cancel();
      return FILE_TOO_LARGE;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type SrcListing = {
  values?: { path: string; type: string }[];
  next?: string;
};

/**
 * Lists one directory at a ref (the root for an empty path), following the
 * listing's `next` links. Empty on 404. Entries carry their full repo path.
 */
export async function listRepoDir(
  auth: BitbucketAuth,
  repoFullName: string,
  ref: string,
  path: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ path: string; type: "file" | "dir" }[]> {
  assertRepo(repoFullName);
  const prefix = `${API}/${repoFullName}`;
  let suffix = `${srcSuffix(ref, path)}/?pagelen=${DIR_PAGE_LENGTH}`;
  const entries: { path: string; type: "file" | "dir" }[] = [];
  for (let page = 0; page < MAX_DIR_PAGES; page++) {
    let listing: SrcListing;
    try {
      const res = await request(
        auth,
        "GET",
        repoFullName,
        suffix,
        undefined,
        fetchImpl
      );
      listing = (await res.json()) as SrcListing;
    } catch (error) {
      if (error instanceof CiProviderError && error.status === 404) {
        return entries;
      }
      throw error;
    }
    for (const value of listing.values ?? []) {
      if (value.type === "commit_file") {
        entries.push({ path: value.path, type: "file" });
      } else if (value.type === "commit_directory") {
        entries.push({ path: value.path, type: "dir" });
      }
    }
    // The credentials only go to the Bitbucket API, whatever `next` says.
    if (!listing.next?.startsWith(`${prefix}/`)) break;
    suffix = listing.next.slice(prefix.length);
  }
  return entries;
}

/** The commit a branch points at now. Throws CiProviderError on any failure. */
export async function getBranchHead(
  auth: BitbucketAuth,
  repoFullName: string,
  branch: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  assertRepo(repoFullName);
  assertBranch(branch);
  const res = await request(
    auth,
    "GET",
    repoFullName,
    `/refs/branches/${encodeURIComponent(branch)}`,
    undefined,
    fetchImpl
  );
  const hash = ((await res.json()) as { target?: { hash?: unknown } }).target
    ?.hash;
  if (typeof hash !== "string" || !/^[0-9a-f]{7,64}$/.test(hash)) {
    throw new CiProviderError(
      `Bitbucket GET ${repoFullName}/refs/branches returned no commit hash`,
      res.status
    );
  }
  return hash;
}

const MAX_ARCHIVE_REDIRECTS = 3;
// Covers connecting and the response headers only; the body then streams
// without a deadline (an archive can be large).
const ARCHIVE_TIMEOUT_MS = 60_000;

/**
 * The repository at a commit as a tar.gz byte stream, from
 * bitbucket.org/{repo}/get/{sha}.tar.gz. That host redirects to a signed
 * download URL: the Basic credentials go only to the first request, and a
 * redirect is followed only over https.
 */
export async function downloadArchive(
  auth: BitbucketAuth,
  repoFullName: string,
  sha: string,
  fetchImpl: typeof fetch = fetch
): Promise<ReadableStream<Uint8Array>> {
  assertRepo(repoFullName);
  if (!/^[0-9a-f]{7,64}$/.test(sha)) {
    throw new Error("Invalid commit sha for a Bitbucket archive");
  }
  const label = `Bitbucket GET ${repoFullName}/get/${sha}.tar.gz`;
  let url = `https://bitbucket.org/${repoFullName}/get/${sha}.tar.gz`;
  let headers: Record<string, string> | undefined = {
    Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.token}`).toString("base64")}`,
  };
  for (let hop = 0; hop <= MAX_ARCHIVE_REDIRECTS; hop++) {
    let res: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARCHIVE_TIMEOUT_MS);
    try {
      res = await fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new CiProviderError(`${label} unreachable`, 0);
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const location = res.headers.get("location");
      const next = location ? new URL(location, url) : null;
      if (next?.protocol !== "https:") {
        throw new CiProviderError(
          `${label} redirected to an unusable location`,
          res.status
        );
      }
      url = next.toString();
      headers = undefined;
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new CiProviderError(
        `${label} failed with ${res.status}`,
        res.status
      );
    }
    return res.body;
  }
  throw new CiProviderError(`${label} redirected too many times`, 0);
}
