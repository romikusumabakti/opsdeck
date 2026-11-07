import { z } from "zod";

/** A Docker network name as `docker network create` accepts it. */
export const dockerNetworkSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/, "Invalid network name");

const BUILT_IN_NETWORKS = new Set(["bridge", "host", "none"]);

/**
 * The first user-defined network in the output of
 * `docker inspect -f '{{json .NetworkSettings.Networks}}' <container>`, or
 * null when there is none (or the output is not that JSON). Only the network
 * names are read; the rest of the document is ignored.
 */
export function firstUserNetwork(inspectOutput: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspectOutput.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return (
    Object.keys(parsed).find(
      (name) =>
        !BUILT_IN_NETWORKS.has(name) &&
        dockerNetworkSchema.safeParse(name).success
    ) ?? null
  );
}
