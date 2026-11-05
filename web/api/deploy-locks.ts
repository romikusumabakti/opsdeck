import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

const routes = api.api.environments;

export async function getDeployLock(environmentId: string) {
  return parseResponse(
    routes[":id"]["deploy-lock"].$get({ param: { id: environmentId } })
  );
}

export const getDeployLockQuery = (...args: Parameters<typeof getDeployLock>) =>
  queryOptions({
    queryKey: ["deploy-locks", "getDeployLock", args],
    queryFn: () => getDeployLock(...args),
  });

/** Locks the environment, or changes the reason and expiry of a lock you may unlock. */
export async function lockEnvironment(
  environmentId: string,
  input: { reason: string; expiresAt: string }
) {
  return parseResponse(
    routes[":id"]["deploy-lock"].$put({
      param: { id: environmentId },
      json: input,
    })
  );
}

export async function unlockEnvironment(environmentId: string) {
  return parseResponse(
    routes[":id"]["deploy-lock"].$delete({ param: { id: environmentId } })
  );
}

export async function forceUnlockEnvironment(
  environmentId: string,
  reason: string
) {
  return parseResponse(
    routes[":id"]["deploy-lock"]["force-unlock"].$post({
      param: { id: environmentId },
      json: { reason },
    })
  );
}

export type DeployLockState = Awaited<ReturnType<typeof getDeployLock>>;
