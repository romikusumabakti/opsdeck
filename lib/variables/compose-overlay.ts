import { stringify } from "yaml";
import { composeServiceSchema } from "@/lib/deploy/validation";
import { dockerNetworkSchema } from "@/lib/setup/network";

/** The compose file, next to `compose.yaml`, the Panel writes for a shared database network. */
export const COMPOSE_OVERLAY_FILE = "compose.opsdeck.yaml";

export const COMPOSE_OVERLAY_HEADER =
  "# Written by the DSS Panel; do not edit. Joins the services to the shared database network.";

/**
 * The compose overlay that joins `services` to the external Docker `network`
 * of a shared database host: each service keeps `default` (so it still reaches
 * its own stack) and gains `network`. Compose merges `networks` lists across
 * files, so a service that also declares its own networks keeps them.
 *
 * Built as a YAML document, never by interpolating strings: a name YAML would
 * read as a bool, null or number (`true`, `null`, `123`, `1e3`) is emitted
 * quoted so Compose reads a string. The schema is YAML 1.1 so that `no`, `on`
 * and friends are quoted too (Compose's parser still honours them in places).
 * Throws on an invalid service or network name, or no service.
 */
export function renderComposeOverlay(
  services: string[],
  network: string
): string {
  if (services.length === 0) throw new Error("At least one service is needed");
  const names = services.map((s) => composeServiceSchema.parse(s));
  if (new Set(names).size !== names.length) {
    throw new Error("Duplicate service");
  }
  const net = dockerNetworkSchema.parse(network);
  const body = stringify(
    {
      services: Object.fromEntries(
        names.map((name) => [name, { networks: ["default", net] }])
      ),
      networks: { [net]: { external: true } },
    },
    { schema: "yaml-1.1" }
  );
  return `${COMPOSE_OVERLAY_HEADER}\n${body}`;
}
