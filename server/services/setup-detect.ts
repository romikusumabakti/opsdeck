import { HTTPException } from "hono/http-exception";
import {
  type BitbucketAuth,
  listRepoDir,
  readRepoFile,
} from "@/lib/ci/forges/bitbucket";
import { CiProviderError } from "@/lib/ci/types";
import {
  COMPOSE_FILE_NAMES,
  detectRepo,
  type RepoDetection,
} from "@/lib/setup/detect";
import { badRequest, notFound } from "@/server/errors";
import { requireRegistrant } from "@/server/services/apps";
import {
  getForgeCredentials,
  getProviderForConnection,
} from "@/server/services/ci-connections";

/**
 * Reads a component repository through its CI connection's forge credentials
 * and reports what the setup wizard can build on: the compose file, its
 * runtime services and the Dockerfiles. Same gate as listRegistrableRepos
 * (app registrants), and only repositories the CI server knows are readable,
 * so the forge token is not a general-purpose file reader. Only the compose
 * file's content is fetched; the Dockerfiles are found by name.
 */
export async function detectComponentRepo(
  connectionId: string,
  repoFullName: string,
  branch: string
): Promise<RepoDetection> {
  await requireRegistrant();
  const provider = await getProviderForConnection(connectionId);
  const { forge, auth } = await getForgeCredentials(connectionId);
  if (forge !== "bitbucket" || !auth) {
    badRequest("The CI connection cannot read repository files");
  }
  try {
    const repos = await provider.listRepos();
    if (!repos.some((repo) => repo.fullName === repoFullName)) notFound();
    return await readAndDetect(auth, repoFullName, branch);
  } catch (error) {
    // The provider's message is built without credentials.
    if (error instanceof CiProviderError) {
      throw new HTTPException(502, {
        message: `Reading the repository failed: ${error.message}`,
      });
    }
    throw error;
  }
}

async function readAndDetect(
  auth: BitbucketAuth,
  repoFullName: string,
  branch: string
): Promise<RepoDetection> {
  const root = await listRepoDir(auth, repoFullName, branch, "");
  const dirs = root.filter((e) => e.type === "dir");
  const nested = await Promise.all(
    dirs.map((dir) => listRepoDir(auth, repoFullName, branch, dir.path))
  );
  const files = [...root, ...nested.flat()].filter((e) => e.type === "file");

  const composeName = COMPOSE_FILE_NAMES.find((name) =>
    files.some((f) => f.path === name)
  );
  const composeContent = composeName
    ? await readRepoFile(auth, repoFullName, branch, composeName)
    : null;
  return detectRepo(
    files.map((f) =>
      f.path === composeName && composeContent !== null
        ? { path: f.path, content: composeContent }
        : { path: f.path }
    )
  );
}
