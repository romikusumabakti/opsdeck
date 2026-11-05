import type { EnvironmentVariable } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/secrets";
import {
  getEnvironmentContext,
  listVariables,
} from "@/lib/variables/repository";

/**
 * A stored variable's value in clear: plain values are stored as text, secret
 * and generated ones encrypted (lib/secrets).
 */
export function decodeVariableValue(
  row: Pick<EnvironmentVariable, "kind" | "value">
): string {
  return row.kind === "plain" ? row.value : decryptSecret(row.value);
}

/**
 * The decrypted variables of an environment whose `.env` the Panel manages,
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
