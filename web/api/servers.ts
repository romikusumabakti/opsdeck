import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api.servers;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function getServers() {
  return parseResponse(routes["get-servers"].$get());
}

export const getServersQuery = (...args: Parameters<typeof getServers>) =>
  queryOptions({
    queryKey: ["servers", "getServers", args],
    queryFn: () => getServers(...args),
  });

export async function getServerById(id: string) {
  return parseResponse(routes["get-server-by-id"].$get({ query: { id } }));
}

export const getServerByIdQuery = (...args: Parameters<typeof getServerById>) =>
  queryOptions({
    queryKey: ["servers", "getServerById", args],
    queryFn: () => getServerById(...args),
  });

export async function getServerUsage(serverId: string) {
  return parseResponse(
    routes["get-server-usage"].$get({ query: { serverId } })
  );
}

export const getServerUsageQuery = (
  ...args: Parameters<typeof getServerUsage>
) =>
  queryOptions({
    queryKey: ["servers", "getServerUsage", args],
    queryFn: () => getServerUsage(...args),
  });

export async function createServer(data: Body<"create-server">["data"]) {
  return orFailure(
    () => parseResponse(routes["create-server"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function updateServer(
  id: Body<"update-server">["id"],
  data: Body<"update-server">["data"]
) {
  return orFailure(
    () => parseResponse(routes["update-server"].$post({ json: { id, data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function testServerConnection(
  input: Body<"test-server-connection">["input"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["test-server-connection"].$post({ json: { input } })
      ),
    (message) => ({ ok: false, message }) as const
  );
}

export async function bulkDeleteServers(
  ids: Body<"bulk-delete-servers">["ids"]
) {
  return orFailure(
    () => parseResponse(routes["bulk-delete-servers"].$post({ json: { ids } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteServer(id: Body<"delete-server">["id"]) {
  return orFailure(
    () => parseResponse(routes["delete-server"].$post({ json: { id } })),
    (message) => ({ success: false, message }) as const
  );
}

export type ServerRow = Awaited<ReturnType<typeof getServers>>[number];

export async function runServerPreflight(id: string) {
  return parseResponse(routes[":id"].preflight.$post({ param: { id } }));
}

export async function getServerPreflight(id: string) {
  return parseResponse(routes[":id"].preflight.$get({ param: { id } }));
}

export const getServerPreflightQuery = (
  ...args: Parameters<typeof getServerPreflight>
) =>
  queryOptions({
    queryKey: ["servers", "getServerPreflight", args],
    queryFn: () => getServerPreflight(...args),
  });

// SSH access (org server:manage). A refusal rejects with an ApiError whose
// `code` is stable (keyJobRunning, hostKeyChanged, …) and message translated.

/** Moves a password server to the instance key with its stored password. */
export async function moveServerToKey(id: string) {
  return parseResponse(routes[":id"]["move-to-key"].$post({ param: { id } }));
}

/** Installs the key with a password typed once; the Panel never stores it. */
export async function reinstallServerKey(id: string, password: string) {
  return parseResponse(
    routes[":id"]["reinstall-key"].$post({ param: { id }, json: { password } })
  );
}

/**
 * Pins the host key the server offered. `expectedFingerprint` is the one the
 * admin was shown: a key that changed again since is refused.
 */
export async function trustServerHostKey(
  id: string,
  expectedFingerprint: string
) {
  return parseResponse(
    routes[":id"]["trust-host-key"].$post({
      param: { id },
      json: { expectedFingerprint },
    })
  );
}

/**
 * The install command for a key server's own key (the one its row names),
 * restricted to `from`.
 */
export async function getServerAuthorizedLine(id: string, from: string) {
  return parseResponse(
    routes[":id"]["authorized-line"].$get({ param: { id }, query: { from } })
  );
}

export const getServerAuthorizedLineQuery = (id: string, from: string) =>
  queryOptions({
    queryKey: ["servers", "getServerAuthorizedLine", id, from],
    queryFn: () => getServerAuthorizedLine(id, from),
    retry: false,
  });

/**
 * Signs in to a key server with its key alone; on success the server counts
 * as verified and `from` (when given) is saved as its from= address.
 */
export async function checkServerKeyLogin(id: string, from?: string) {
  return parseResponse(
    routes[":id"]["check-key-login"].$post({
      param: { id },
      json: from === undefined ? {} : { from },
    })
  );
}
