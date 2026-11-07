import { z } from "zod";

const BUILT_IN_NETWORKS = new Set(["bridge", "host", "none"]);

/**
 * Names a shared database network can never have: Docker's built-in networks,
 * and `default`, which Compose reserves for a stack's own network (the overlay
 * lists it next to the shared one).
 */
const RESERVED_NETWORKS = new Set([...BUILT_IN_NETWORKS, "default"]);

/** A Docker network name as `docker network create` accepts it. */
export const dockerNetworkSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/, "Invalid network name")
  .refine((name) => !RESERVED_NETWORKS.has(name), "Reserved network name");

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
