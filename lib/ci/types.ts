export type CiRepo = {
  ciRepoId: string;
  fullName: string;
  forgeRemoteId: string;
  active: boolean;
};

export type RepoSettings = {
  timeoutMinutes: number;
  cancelPreviousOnPush: boolean;
  // The Panel does not use Woodpecker's configuration extension; null clears
  // any endpoint left on the repo.
  configExtensionEndpoint: string | null;
};

export type SecretEvent = "push" | "manual";

/**
 * The last attempt to commit the generated pipeline file to one branch: the
 * commit sha (kept from the last success when a later attempt fails), the
 * failure reason, and when it was tried (ISO string).
 */
export type PipelineFileCommit = { sha?: string; error?: string; at: string };

/** Branch → its PipelineFileCommit (`app_components.pipeline_file_commits`). */
export type PipelineFileCommits = Record<string, PipelineFileCommit>;

export interface CiProvider {
  listRepos(): Promise<CiRepo[]>;
  /** Activates the repo; an already active repo is returned as is. */
  activateRepo(forgeRemoteId: string): Promise<CiRepo>;
  updateRepoSettings(ciRepoId: string, settings: RepoSettings): Promise<void>;
  upsertRepoSecret(
    ciRepoId: string,
    name: string,
    value: string,
    events: SecretEvent[]
  ): Promise<void>;
}

/** A failed CI provider call. The message never contains credentials. */
export class CiProviderError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CiProviderError";
    this.status = status;
  }
}
