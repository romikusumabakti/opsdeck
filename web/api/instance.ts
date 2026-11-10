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

/** Restores a backup from the history; `confirm` is the instance name. */
export async function restoreInstanceBackup(id: string, confirm: string) {
  return parseResponse(
    routes.backups[":id"].restore.$post({ param: { id }, json: { confirm } })
  );
}

export async function getInstanceUpdates() {
  return parseResponse(routes.updates.$get());
}

export const getInstanceUpdatesQuery = () =>
  queryOptions({
    queryKey: ["instance", "getInstanceUpdates"],
    queryFn: getInstanceUpdates,
  });

export type InstanceUpdateSettingsBody = InferRequestType<
  (typeof routes.updates.settings)["$put"]
>["json"];

export async function saveInstanceUpdateSettings(
  json: InstanceUpdateSettingsBody
) {
  return parseResponse(routes.updates.settings.$put({ json }));
}

export async function applyInstanceUpdate(version: string) {
  return parseResponse(routes.updates.apply.$post({ json: { version } }));
}

/** Undoes a failed restore with the safety backup named by the status. */
export async function restoreSafetyBackup(confirm: string) {
  return parseResponse(
    routes.updates["restore-safety-backup"].$post({ json: { confirm } })
  );
}

export type InstanceUpdatesData = Awaited<
  ReturnType<typeof getInstanceUpdates>
>;

const sshKey = routes["ssh-key"];

/** The instance SSH key (public half only) and the last key job. */
export async function getInstanceSshKey() {
  return parseResponse(sshKey.$get());
}

export const getInstanceSshKeyQuery = () =>
  queryOptions({
    queryKey: ["instance", "getInstanceSshKey"],
    queryFn: getInstanceSshKey,
  });

export type InstanceSshKeyData = Awaited<ReturnType<typeof getInstanceSshKey>>;

export async function moveAllServersToKey() {
  return parseResponse(sshKey["move-all"].$post());
}

export async function rotateInstanceSshKey() {
  return parseResponse(sshKey.rotate.$post());
}

/** The authorized_keys line for `from` and the command that installs it. */
export async function getAuthorizedKeysLine(from: string) {
  return parseResponse(sshKey["authorized-line"].$get({ query: { from } }));
}

export const getAuthorizedKeysLineQuery = (from: string) =>
  queryOptions({
    queryKey: ["instance", "getAuthorizedKeysLine", from],
    queryFn: () => getAuthorizedKeysLine(from),
    retry: false,
  });

// --- Archives of deleted environments ---

export async function listEnvironmentArchives() {
  return parseResponse(routes["environment-archives"].$get());
}

export const listEnvironmentArchivesQuery = () =>
  queryOptions({
    queryKey: ["instance", "listEnvironmentArchives"],
    queryFn: listEnvironmentArchives,
  });

/** The download link of one archived file (streamed, as an attachment). */
export function environmentArchiveFileHref(id: string, name: string): string {
  return `/api/instance/environment-archives/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`;
}

export type EnvironmentArchive = Awaited<
  ReturnType<typeof listEnvironmentArchives>
>[number];
