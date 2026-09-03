import { type Document, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

// Pure reader/editor for a locally-managed `cloudflared` config.yml.
//
// The file on the server is the source of truth for a tunnel's routing — not a
// mirror of anything in this database — so every edit here is a *surgical*
// change to the document the operator wrote, never a regeneration of it. The
// explanatory comments in those files (why a hostname exists, why an origin is
// addressed by container name, what is deliberately NOT published) are the
// reason the file was chosen as the source of truth in the first place, and
// losing them to a round-trip would defeat that. `yaml`'s Document API keeps
// comments and blank lines attached to their nodes; tests/tunnel-ingress.test.ts
// pins that with a byte-for-byte round-trip of a real production config.
//
// Nothing in this module performs I/O. lib/tunnels/remote.ts moves the bytes.

// Serialization options that keep an edited document looking like the one the
// operator wrote. `lineWidth: 0` disables folding: the default 80-column wrap
// would reflow long, untouched `service:` URLs into a different shape and make
// a one-line change look like a rewrite in review.
const STRINGIFY_OPTIONS = {
  lineWidth: 0,
  indent: 2,
  flowCollectionPadding: false,
} as const;

// The `originRequest.connectTimeout` given to every route this panel writes.
// Matches what the existing entries use; 30s is long enough for a container
// that is still warming up and short enough that a dead origin fails visibly.
export const DEFAULT_CONNECT_TIMEOUT = "30s";

export type IngressRoute = {
  hostname: string;
  // The origin as written, e.g. "http://dplk-middleware:3000".
  service: string;
  // `service` split up for display and validation, or null when it isn't a
  // scheme://host:port origin (`http_status:404`, `hello_world`, a unix socket).
  origin: OriginAddress | null;
};

export type OriginAddress = {
  scheme: string;
  host: string;
  port: number | null;
};

export class IngressConfigError extends Error {}

/**
 * Split an ingress `service` value into scheme/host/port.
 *
 * Returns null for the service forms that aren't network origins — the
 * `http_status:404` catch-all, `hello_world`, `bastion`, and unix sockets — so
 * callers can tell "not addressable" from "malformed".
 */
export function parseOrigin(service: string): OriginAddress | null {
  const match = /^(https?|tcp|ssh|rdp):\/\/([^/:]+)(?::(\d+))?/.exec(
    service.trim()
  );
  if (!match) return null;
  const [, scheme, host, port] = match;
  if (!scheme || !host) return null;
  return { scheme, host, port: port ? Number(port) : null };
}

/** Build the `service` value for an origin addressed by container name. */
export function formatOrigin(host: string, port: number): string {
  return `http://${host}:${port}`;
}

function ingressSeq(doc: Document): YAMLSeq {
  const seq = doc.get("ingress") as YAMLSeq | undefined;
  if (!seq || !Array.isArray((seq as { items?: unknown[] }).items)) {
    throw new IngressConfigError(
      "config.yml has no `ingress:` list — this does not look like a cloudflared tunnel config"
    );
  }
  return seq;
}

function itemHostname(item: unknown): string | null {
  const map = item as YAMLMap | undefined;
  if (!map || typeof map.get !== "function") return null;
  const hostname = map.get("hostname");
  return typeof hostname === "string" ? hostname : null;
}

function itemService(item: unknown): string {
  const map = item as YAMLMap;
  const service = map.get("service");
  return typeof service === "string" ? service : "";
}

/**
 * The routes of an ingress table, in file order, excluding the trailing
 * catch-all. cloudflared requires the last rule to match everything, so it has
 * no `hostname` and is structural rather than a route an operator manages.
 */
export function parseIngress(source: string): IngressRoute[] {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    throw new IngressConfigError(
      `config.yml is not valid YAML: ${doc.errors[0]?.message ?? "unknown parse error"}`
    );
  }
  const items = ingressSeq(doc).items;
  const routes: IngressRoute[] = [];
  for (const item of items) {
    const hostname = itemHostname(item);
    if (!hostname) continue;
    const service = itemService(item);
    routes.push({ hostname, service, origin: parseOrigin(service) });
  }
  return routes;
}

/** The tunnel UUID the config runs, used to build the CNAME target. */
export function parseTunnelId(source: string): string | null {
  const doc = parseDocument(source);
  const value = doc.get("tunnel");
  return typeof value === "string" ? value : null;
}

/**
 * Assert the invariant cloudflared itself enforces: the last ingress rule must
 * match all traffic, i.e. carry no `hostname`. Checked before AND after every
 * edit — an ingress whose catch-all is not last is rejected at startup, which
 * would take every hostname on the tunnel down, not just the one being changed.
 */
export function assertCatchAllLast(source: string): void {
  const items = ingressSeq(parseDocument(source)).items;
  if (items.length === 0) {
    throw new IngressConfigError(
      "ingress list is empty — expected a catch-all rule"
    );
  }
  if (itemHostname(items.at(-1)) !== null) {
    throw new IngressConfigError(
      "the last ingress rule has a `hostname` — cloudflared requires the final rule to be a catch-all (e.g. `- service: http_status:404`)"
    );
  }
  for (const item of items.slice(0, -1)) {
    if (itemHostname(item) === null) {
      throw new IngressConfigError(
        "an ingress rule before the last one has no `hostname` — it would swallow every request that follows it"
      );
    }
  }
}

/**
 * Insert a route immediately before the catch-all and return the new document
 * text. Throws if the hostname is already routed: silently replacing an
 * existing rule would move traffic without anyone asking for it.
 */
export function addRoute(
  source: string,
  route: { hostname: string; service: string; connectTimeout?: string }
): string {
  assertCatchAllLast(source);
  const doc = parseDocument(source);
  const seq = ingressSeq(doc);

  if (seq.items.some((item) => itemHostname(item) === route.hostname)) {
    throw new IngressConfigError(
      `${route.hostname} is already routed by this tunnel`
    );
  }

  const node = doc.createNode({
    hostname: route.hostname,
    service: route.service,
    originRequest: {
      connectTimeout: route.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT,
    },
  });
  // The existing entries are separated by blank lines; a new one that isn't
  // would read as belonging to the block above it.
  (node as { spaceBefore?: boolean }).spaceBefore = true;

  seq.items.splice(seq.items.length - 1, 0, node);

  const next = doc.toString(STRINGIFY_OPTIONS);
  assertCatchAllLast(next);
  return next;
}

/**
 * Remove the route for `hostname` and return the new document text. Any comment
 * written above that entry is attached to it and goes with it, which is what an
 * operator deleting the route would do by hand.
 */
export function removeRoute(source: string, hostname: string): string {
  assertCatchAllLast(source);
  const doc = parseDocument(source);
  const seq = ingressSeq(doc);

  const index = seq.items.findIndex((item) => itemHostname(item) === hostname);
  if (index === -1) {
    throw new IngressConfigError(`${hostname} is not routed by this tunnel`);
  }

  // The first entry carries no `spaceBefore`, so deleting it would leave the
  // one that takes its place glued to the header above. Hand the flag over.
  const removed = seq.items[index] as { spaceBefore?: boolean };
  const successor = seq.items[index + 1] as
    | { spaceBefore?: boolean }
    | undefined;
  if (index === 0 && successor && !removed.spaceBefore) {
    successor.spaceBefore = false;
  }
  seq.items.splice(index, 1);

  const next = doc.toString(STRINGIFY_OPTIONS);
  assertCatchAllLast(next);
  return next;
}
