import type { EnvironmentVariable, VariableKind } from "@/lib/db/schema";
import {
  listServicesInDeployDir,
  listTagVariablesInDeployDir,
} from "@/lib/deploy/repository";
import { COMPOSE_OVERRIDE_FILE } from "@/lib/deploy/script";
import { decryptSecret } from "@/lib/secrets";
import { COMPOSE_OVERLAY_FILE } from "@/lib/variables/compose-overlay";
import { parseDotenv } from "@/lib/variables/dotenv";
import { renderEnvFile } from "@/lib/variables/env-file";
import { looksSecret } from "@/lib/variables/import-rows";
import {
  getEnvironmentContext,
  getSharedDatabaseNetwork,
  listVariables,
} from "@/lib/variables/repository";
import { isReservedVariableName } from "@/lib/variables/validation";

/**
 * A stored variable's value in clear: plain values are stored as text, secret
 * and generated ones encrypted (lib/secrets).
 */
export function decodeVariableValue(
  row: Pick<EnvironmentVariable, "kind" | "value">
): string {
  return row.kind === "plain" ? row.value : decryptSecret(row.value);
}

/** An environment's stored variables, decrypted (server-side only). */
export type DecodedVariable = {
  name: string;
  kind: VariableKind;
  value: string;
};

/**
 * Every stored variable of an environment, decrypted, whether or not the
 * Menara manages its `.env`. No permission check: callers check first.
 */
export async function loadEnvFileVariables(
  environmentId: string
): Promise<DecodedVariable[]> {
  const rows = await listVariables(environmentId);
  return rows.map((row) => ({
    name: row.name,
    kind: row.kind,
    value: decodeVariableValue(row),
  }));
}

/**
 * The decrypted variables of an environment whose `.env` Menara manages,
 * or null when it does not manage it. For the deploy job, which runs as the
 * system: there is no permission check, so never call it for an HTTP request.
 */
export async function loadManagedEnvFileVariables(
  environmentId: string
): Promise<{ name: string; value: string }[] | null> {
  const env = await getEnvironmentContext(environmentId);
  if (!env) throw new Error(`Environment ${environmentId} not found`);
  if (!env.envFileManaged) return null;
  const rows = await listVariables(env.id);
  return rows.map((row) => ({
    name: row.name,
    value: decodeVariableValue(row),
  }));
}

/** What a managed `.env` of one (server, deploy dir) is rendered from, besides the variables. */
export type ManagedEnvFileInputs = {
  /**
   * Every tag variable written to this dir's `.env`: the deploying target's
   * and, for a multi-component app, the other components'.
   */
  tagVariables: string[];
  /**
   * The shared database host's Docker network the services join through the
   * compose overlay (lib/variables/compose-overlay), or null for none.
   */
  databaseNetwork: string | null;
  /**
   * Every service of every target in this dir (with a network only), so one
   * component's deploy never drops another's from the network.
   */
  overlayServices: string[];
  /** The `COMPOSE_FILE` list Menara writes (with a network only). */
  composeFiles?: string[];
};

/**
 * The per-dir inputs of a managed `.env`, shared by the deploy job
 * (runClaimedDeployment) and the preview so the two never drift. No
 * permission check.
 */
export async function managedEnvFileInputs(
  environmentId: string,
  serverId: string,
  deployDir: string
): Promise<ManagedEnvFileInputs> {
  const tagVariables = await listTagVariablesInDeployDir(serverId, deployDir);
  const databaseNetwork = await getSharedDatabaseNetwork(
    environmentId,
    serverId
  );
  const overlayServices = databaseNetwork
    ? await listServicesInDeployDir(serverId, deployDir)
    : [];
  return {
    tagVariables,
    databaseNetwork,
    overlayServices,
    ...(databaseNetwork
      ? { composeFiles: ["compose.yaml", COMPOSE_OVERLAY_FILE] }
      : {}),
  };
}

/**
 * The `COMPOSE_FILE` list with `compose.override.yaml` right after
 * `compose.yaml`: what the deploy script's OVERRIDE_SED_EXPR (lib/deploy/
 * script) makes of the staged line when the override exists on the server.
 */
function withComposeOverride(files: string[]): string[] {
  return files[0] === "compose.yaml" && files.length > 1
    ? [files[0], COMPOSE_OVERRIDE_FILE, ...files.slice(1)]
    : files;
}

/**
 * Renders a managed `.env` from its inputs (renderEnvFile; throws as it
 * does). The deploy job stages it as is, and its script inserts the server's
 * `compose.override.yaml`; with `overridePresent` (the preview) the override
 * is inserted here instead, so the result is the file the deploy installs.
 */
export function renderManagedEnvFile(
  vars: readonly { name: string; value: string }[],
  tags: Record<string, string>,
  registry: string,
  inputs: Pick<ManagedEnvFileInputs, "composeFiles">,
  { overridePresent = false }: { overridePresent?: boolean } = {}
): string {
  const files = inputs.composeFiles;
  return renderEnvFile(
    vars.map(({ name, value }) => ({ name, value })),
    tags,
    registry,
    files
      ? { composeFiles: overridePresent ? withComposeOverride(files) : files }
      : {}
  );
}

/** One key that differs between the live `.env` and the managed one. */
export type EnvFileChange = {
  name: string;
  /** changed: in both; added: managed only; removed: live only. */
  status: "changed" | "added" | "removed";
  /** Values left out: a stored non-plain variable, or a live-only key that looks secret. */
  masked: boolean;
  /** Written by Menara itself: `DOCKER_REGISTRY`, tag variables, `COMPOSE_FILE`. */
  menaraWritten: boolean;
  /** A live `COMPOSE_*`/`DOCKER_*`/`BUILDKIT_*` key the managed file drops. */
  reserved: boolean;
  /** The live value (unmasked only). */
  before?: string;
  /** The managed value (unmasked only); none for a tag set at the next deploy. */
  after?: string;
};

/**
 * A `.env`'s values by name, parsed as Compose does (the last definition
 * wins). Throws on an unparsable text, with no text in the error.
 */
export function envFileValues(text: string): Map<string, string> {
  const parsed = parseDotenv(text);
  if ("error" in parsed) throw new Error("Unparsable .env");
  return new Map(parsed.entries.map((e) => [e.name, e.value]));
}

/**
 * The per-key semantic diff between a dir's live `.env` (null: none) and
 * the managed one: both parsed as Compose does (lib/variables/dotenv), so
 * order, quoting and comments are not changes. `pendingTags` are tag
 * variables the preview could not take from the live file (missing or not
 * a valid tag): the next deploy writes them, so they show without a managed
 * value. Pure; `rendered` comes from renderManagedEnvFile, `live` from a
 * file the reader parsed already (throws on an unparsable text).
 */
export function diffEnvFile({
  rendered,
  live,
  kinds,
  tagNames,
  pendingTags = [],
}: {
  rendered: string;
  live: string | null;
  /** The stored variables' kinds by name. */
  kinds: ReadonlyMap<string, VariableKind>;
  /** Every tag variable of the dir. */
  tagNames: readonly string[];
  pendingTags?: readonly string[];
}): { changes: EnvFileChange[]; unchangedCount: number } {
  const managed = envFileValues(rendered);
  const current =
    live === null ? new Map<string, string>() : envFileValues(live);
  const names = [
    ...new Set([...managed.keys(), ...current.keys(), ...pendingTags]),
  ].sort();

  const changes: EnvFileChange[] = [];
  let unchangedCount = 0;
  for (const name of names) {
    const before = current.get(name);
    const pending = pendingTags.includes(name);
    const after = pending ? undefined : managed.get(name);
    if (!pending && before !== undefined && before === after) {
      unchangedCount += 1;
      continue;
    }
    const inManaged = pending || managed.has(name);
    const menaraWritten =
      name === "DOCKER_REGISTRY" ||
      tagNames.includes(name) ||
      (name === "COMPOSE_FILE" && inManaged);
    const kind = kinds.get(name);
    const masked = menaraWritten
      ? false
      : kind !== undefined
        ? kind !== "plain"
        : looksSecret(name, before ?? after ?? "");
    const change: EnvFileChange = {
      name,
      status:
        before === undefined ? "added" : inManaged ? "changed" : "removed",
      masked,
      menaraWritten,
      reserved: !inManaged && isReservedVariableName(name),
    };
    if (!masked && before !== undefined) change.before = before;
    if (!masked && after !== undefined) change.after = after;
    changes.push(change);
  }
  return { changes, unchangedCount };
}
