export type CiRepo = {
  ciRepoId: string;
  fullName: string;
  forgeRemoteId: string;
  active: boolean;
};

export type RepoSettings = {
  timeoutMinutes: number;
  cancelPreviousOnPush: boolean;
  configExtensionEndpoint: string | null;
};

export type SecretEvent = "push" | "manual";

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
