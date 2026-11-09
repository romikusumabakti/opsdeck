import { queryOptions } from "@tanstack/react-query";
import { type InferRequestType, parseResponse } from "hono/client";
import { api } from "@/web/api/client";

const routes = api.api.instance;

export async function getInstanceBackups() {
  return parseResponse(routes.backups.$get());
}

export const getInstanceBackupsQuery = () =>
  queryOptions({
    queryKey: ["instance", "getInstanceBackups"],
    queryFn: getInstanceBackups,
  });

export type InstanceBackupSettingsBody = InferRequestType<
  (typeof routes.backups.settings)["$put"]
>["json"];

export async function saveInstanceBackupSettings(
  json: InstanceBackupSettingsBody
) {
  return parseResponse(routes.backups.settings.$put({ json }));
}

export async function runInstanceBackupNow() {
  return parseResponse(routes.backups.run.$post());
}

export async function acknowledgeInstanceBackup(id: string) {
  return parseResponse(
    routes.backups[":id"].acknowledge.$post({ param: { id } })
  );
}

/** Compares the key's fingerprint with the instance's; the key is not kept. */
export async function verifySecretsKey(key: string) {
  return parseResponse(routes.backups["verify-key"].$post({ json: { key } }));
}

export type InstanceBackupsData = Awaited<
  ReturnType<typeof getInstanceBackups>
>;
export type InstanceBackupRow = InstanceBackupsData["backups"][number];
