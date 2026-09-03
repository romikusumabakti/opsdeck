import { parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

// Pure reader/editor for the compose file of a tunnel stack.
//
// Only one edit is ever made here: attaching the cloudflared container to one
// more application network. It exists because that is the step a *new*
// application always needs — each app stack owns its own network, and an
// ingress rule pointing at a container cloudflared cannot reach produces a 502
// from the edge that reads like a broken application rather than a routing gap.
//
// Every network this file adds is declared `external: true`, without exception.
// The networks belong to the application stacks; if this stack ever owned one,
// `compose down` here would try to remove a network that live applications are
// still attached to.
//
// As in lib/tunnels/ingress.ts, edits are surgical and comment-preserving —
// see the round-trip test in tests/tunnel-compose.test.ts.

const STRINGIFY_OPTIONS = {
  lineWidth: 0,
  indent: 2,
  flowCollectionPadding: false,
} as const;

export class ComposeConfigError extends Error {}

function servicesMap(doc: ReturnType<typeof parseDocument>): YAMLMap {
  const services = doc.get("services") as YAMLMap | undefined;
  if (!services || typeof services.get !== "function") {
    throw new ComposeConfigError("compose file has no `services:` block");
  }
  return services;
}

/**
 * The compose service key running `containerName`, e.g. "cloudflared".
 *
 * Matched on `container_name` rather than assumed, because the key is the
 * author's choice: the tunnel stacks on 192.168.55.136 both name the service
 * `cloudflared` while running it as `apps-cloudflared` and
 * `zitadel-cloudflared`.
 */
export function findServiceKeyByContainerName(
  source: string,
  containerName: string
): string | null {
  const doc = parseDocument(source);
  for (const pair of servicesMap(doc).items) {
    const key = String((pair.key as { value?: unknown })?.value ?? pair.key);
    const value = pair.value as YAMLMap | undefined;
    if (value?.get?.("container_name") === containerName) return key;
  }
  return null;
}

/**
 * The real Docker network names this compose file maps, keyed by the local
 * alias each is referenced under.
 *
 * Compose aliases and real names differ here on purpose (`customer-portal` ->
 * `dplk-customer-portal_default`), so a caller holding a name from
 * `docker inspect` cannot match against the alias and has to look through this.
 */
export function composeNetworks(source: string): Map<string, string> {
  const doc = parseDocument(source);
  const networks = doc.get("networks") as YAMLMap | undefined;
  const result = new Map<string, string>();
  if (!networks || !Array.isArray(networks.items)) return result;
  for (const pair of networks.items) {
    const alias = String((pair.key as { value?: unknown })?.value ?? pair.key);
    const value = pair.value as YAMLMap | undefined;
    const name = value?.get?.("name");
    // `name:` is optional — without it compose uses the alias verbatim.
    result.set(alias, typeof name === "string" ? name : alias);
  }
  return result;
}

/**
 * A compose alias for a real network name: the name with the `_default` suffix
 * compose itself appends stripped off, so `dplk-dms_default` reads as `dms`
 * would in a hand-written file. Suffixed with `-2`, `-3`… only on collision.
 */
export function deriveNetworkAlias(
  realName: string,
  taken: Iterable<string>
): string {
  const used = new Set(taken);
  const base =
    realName.replace(/_default$/, "").replace(/[^a-zA-Z0-9_-]/g, "-") || "net";
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Attach the tunnel's service to `realName` and return the new compose text.
 *
 * Idempotent: a network already mapped is returned unchanged, so a caller that
 * retries after a failed apply does not accumulate duplicate entries.
 */
export function addExternalNetwork(
  source: string,
  options: { containerName: string; realName: string }
): string {
  const { containerName, realName } = options;
  const existing = composeNetworks(source);
  for (const [alias, name] of existing) {
    if (name === realName) {
      // Already declared at the top level; it may still be missing from the
      // service's own list, so fall through to that half of the edit only.
      return attachToService(source, containerName, alias);
    }
  }

  const alias = deriveNetworkAlias(realName, existing.keys());
  const doc = parseDocument(source);

  let networks = doc.get("networks") as YAMLMap | undefined;
  if (!networks || !Array.isArray(networks.items)) {
    const created = doc.createNode({}) as YAMLMap;
    (created as { spaceBefore?: boolean }).spaceBefore = true;
    doc.set("networks", created);
    networks = doc.get("networks") as YAMLMap;
  }
  networks.set(alias, doc.createNode({ name: realName, external: true }));

  return attachToService(doc.toString(STRINGIFY_OPTIONS), containerName, alias);
}

function attachToService(
  source: string,
  containerName: string,
  alias: string
): string {
  const doc = parseDocument(source);
  const serviceKey = findServiceKeyByContainerName(source, containerName);
  if (!serviceKey) {
    throw new ComposeConfigError(
      `no compose service declares container_name: ${containerName}`
    );
  }
  const service = servicesMap(doc).get(serviceKey) as YAMLMap;

  const list = service.get("networks") as YAMLSeq | undefined;
  if (!list || !Array.isArray(list.items)) {
    service.set("networks", doc.createNode([alias]));
    return doc.toString(STRINGIFY_OPTIONS);
  }

  const already = list.items.some(
    (item) => String((item as { value?: unknown })?.value ?? item) === alias
  );
  if (already) return source;

  list.add(doc.createNode(alias));
  return doc.toString(STRINGIFY_OPTIONS);
}
