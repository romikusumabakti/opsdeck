import { randomBytes } from "node:crypto";
import {
  insertComponentCreatingApp,
  linkedCiRepos,
  takenComponentKeys,
} from "@/lib/apps";
import { type BuildSpec, buildSpecSchema } from "@/lib/ci/build-spec";
import { bundleImageFor } from "@/lib/ci/registration";
import { CiProviderError, type SecretEvent } from "@/lib/ci/types";
import { appKeySchema, componentKeySchema } from "@/lib/deploy/validation";
import { isUniqueViolation } from "@/lib/people/names";
import { encryptSecret } from "@/lib/secrets";
import {
  getProviderForConnection,
  listConnectionOptions,
} from "@/server/services/ci-connections";

/**
 * Registers a generated artifact component (a jar or a static site) from the
 * command line (scripts/deploy-app.ts `create-artifact`), with no session: the
 * caller is an operator inside the Panel's container. Unlike the register
 * form, the repository may already build other components (one per artifact,
 * each on its own branches); each then reads its notify secret from its own
 * Woodpecker secret, so registering one never overwrites another's.
 */

/** The Woodpecker secret of the first component of a repository. */
export const DEFAULT_NOTIFY_SECRET_NAME = "opsdeck_notify";
export const NOTIFY_SECRET_EVENTS: SecretEvent[] = ["push", "manual"];

/**
 * The Woodpecker secret that carries a component's notify secret: the shared
 * default for a repository's only component, else one named after the
 * component (component keys are lowercase letters, digits and `-`, so the
 * names never collide).
 */
export function notifySecretNameFor(
  componentKey: string,
  repoHasOtherComponent: boolean
): string {
  return repoHasOtherComponent
    ? `${DEFAULT_NOTIFY_SECRET_NAME}_${componentKey.replaceAll("-", "_")}`
    : DEFAULT_NOTIFY_SECRET_NAME;
}

/** A refused or failed registration; the message is safe to print. */
export class ArtifactRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactRegistrationError";
  }
}

export type RegisterArtifactComponentInput = {
  componentKey: string;
  appKey: string;
  /** The repository on the connection's forge, e.g. `dss-consulting/portal`. */
  repoFullName: string;
  /** Needed only when several CI connections exist. */
  ciConnectionName?: string;
  spec: BuildSpec;
};

const REPO_FULL_NAME = /^[\w.-]+\/[\w.-]+$/;

const refuse = (message: string): never => {
  throw new ArtifactRegistrationError(message);
};

/** Runs one Woodpecker call; its failure (credential-free) names the step. */
async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CiProviderError) {
      return refuse(`${label} failed: ${error.message}`);
    }
    throw error;
  }
}

/** The named CI connection, or the only one when no name is given. */
async function resolveConnectionId(name: string | undefined): Promise<string> {
  const connections = await listConnectionOptions();
  const names = connections.map((c) => c.name).join(", ") || "(none)";
  if (name === undefined) {
    const [only] = connections;
    if (connections.length === 1 && only) return only.id;
    return refuse(`Pass a CI connection name. Connections: ${names}`);
  }
  const match = connections.find((c) => c.name === name);
  return match
    ? match.id
    : refuse(`Unknown CI connection "${name}". Connections: ${names}`);
}

/**
 * Validates everything the Panel knows, activates (or finds) the repository
 * in Woodpecker, applies the repo settings (only for a repository's first
 * component), writes the notify secret to Woodpecker, then stores the component (and its app when missing) with
 * `pipeline_mode: "generated"`. Commits no pipeline file: the spec has no
 * branch yet, and picking a target's branch commits it.
 */
export async function registerArtifactComponent(
  input: RegisterArtifactComponentInput
): Promise<{
  componentKey: string;
  ciRepoId: string;
  notifySecretName: string;
}> {
  const { componentKey, appKey, repoFullName } = input;
  const key = componentKeySchema.safeParse(componentKey);
  if (!key.success) refuse(key.error.issues[0]?.message ?? "Invalid key");
  const app = appKeySchema.safeParse(appKey);
  if (!app.success) refuse(app.error.issues[0]?.message ?? "Invalid app key");
  if (!REPO_FULL_NAME.test(repoFullName)) refuse("Repo must be <owner>/<name>");
  const parsed = buildSpecSchema.safeParse(input.spec);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    refuse(
      `Invalid build spec${issue?.path.length ? ` at ${issue.path.join(".")}` : ""}: ${issue?.message ?? "invalid"}`
    );
  }
  const spec = parsed.data as BuildSpec;
  if (!spec.artifact) refuse("The build spec has no artifact");
  if (spec.branches.length > 0) {
    // A listed branch would count as committed and never get its file.
    refuse(
      "The build spec must list no branches: picking a target's branch adds it"
    );
  }
  if ((await takenComponentKeys([componentKey])).length > 0) {
    refuse(`Component ${componentKey} already exists`);
  }

  const ciConnectionId = await resolveConnectionId(input.ciConnectionName);
  const provider = await getProviderForConnection(ciConnectionId);
  const listed = (
    await step("Listing Woodpecker repositories", () => provider.listRepos())
  ).find((r) => r.fullName === repoFullName);
  if (!listed) {
    refuse(`Woodpecker does not list the repository ${repoFullName}`);
  }
  // Woodpecker returns an already active repo as is.
  const repo = await step(`Activating ${repoFullName} in Woodpecker`, () =>
    provider.activateRepo((listed as NonNullable<typeof listed>).forgeRemoteId)
  );
  if (!repo.ciRepoId) refuse(`Woodpecker returned no id for ${repoFullName}`);

  const repoHasOtherComponent = (await linkedCiRepos(ciConnectionId)).some(
    (l) => l.ciRepoId === repo.ciRepoId || l.repoFullName === repo.fullName
  );
  const notifySecretName = notifySecretNameFor(
    componentKey,
    repoHasOtherComponent
  );

  // The settings (timeout included) are per repository: a repository that
  // already builds a component keeps those its first registration applied.
  if (!repoHasOtherComponent) {
    await step(`Updating the Woodpecker settings of ${repo.fullName}`, () =>
      provider.updateRepoSettings(repo.ciRepoId, {
        timeoutMinutes: spec.timeoutMinutes,
        cancelPreviousOnPush: true,
        // The pipeline comes from the committed file only.
        configExtensionEndpoint: null,
      })
    );
  }
  const secret = randomBytes(32).toString("hex");
  await step(`Storing the Woodpecker secret ${notifySecretName}`, () =>
    provider.upsertRepoSecret(
      repo.ciRepoId,
      notifySecretName,
      secret,
      NOTIFY_SECRET_EVENTS
    )
  );

  try {
    await insertComponentCreatingApp(appKey, {
      componentKey,
      ciConnectionId,
      repoFullName: repo.fullName,
      ciRepoId: repo.ciRepoId,
      bundleImage: bundleImageFor(componentKey),
      notifySecret: encryptSecret(secret),
      notifySecretName,
      pipelineMode: "generated",
      buildSpec: spec,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    refuse(
      `Component ${componentKey} was registered meanwhile. Woodpecker may now hold a ${notifySecretName} the Panel does not know: rotate the component's notify secret.`
    );
  }
  return { componentKey, ciRepoId: repo.ciRepoId, notifySecretName };
}
