import { queryOptions } from "@tanstack/react-query";
import { type InferRequestType, parseResponse } from "hono/client";
import { api, apiFetch } from "@/web/api/client";

const routes = api.api.instance;

// --- Branding (Admin › Instance › Branding) ---

/** The stored branding: null fields mean "the default". */
export async function getBranding() {
  return parseResponse(routes.branding.$get());
}

export const getBrandingQuery = () =>
  queryOptions({
    queryKey: ["instance", "getBranding"],
    queryFn: getBranding,
  });

export type BrandingData = Awaited<ReturnType<typeof getBranding>>;

export type BrandingBody = InferRequestType<
  (typeof routes.branding)["$put"]
>["json"];

/** Saves the name, company and accent (not the logos). */
export async function saveBranding(json: BrandingBody) {
  return parseResponse(routes.branding.$put({ json }));
}

export type BrandTheme = "light" | "dark";

/**
 * Uploads the light logo or its dark-mode variant. A refusal is an ApiError
 * whose message is the code (`not_square`, `light_logo_required`, …).
 */
export async function uploadBrandLogo(
  theme: BrandTheme,
  file: File
): Promise<BrandingData> {
  const body = new FormData();
  body.set("file", file);
  // Multipart: sent through apiFetch, since the route reads the form itself.
  const response = await apiFetch(
    `/api/instance/branding/logo?theme=${theme}`,
    { method: "PUT", body }
  );
  return (await response.json()) as BrandingData;
}

/** Removes a logo; removing the light one removes the dark one too. */
export async function removeBrandLogo(theme: BrandTheme) {
  return parseResponse(routes.branding.logo.$delete({ query: { theme } }));
}

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

export type BackupDestinationBody = InferRequestType<
  (typeof routes.backups.destination)["$put"]
>["json"];

/** Sets the backup destination; a blank secret keeps the stored one. */
export async function saveBackupDestination(json: BackupDestinationBody) {
  return parseResponse(routes.backups.destination.$put({ json }));
}

/** Removes the backup destination: backups stay on this server. */
export async function clearBackupDestination() {
  return parseResponse(routes.backups.destination.$delete());
}

/** Probes typed values without saving them. */
export async function testBackupDestination(json: BackupDestinationBody) {
  return parseResponse(routes.backups.destination.test.$post({ json }));
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

/** Re-reads the releases now instead of the hourly cached result. */
export async function checkInstanceUpdates() {
  return parseResponse(routes.updates.check.$post());
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
