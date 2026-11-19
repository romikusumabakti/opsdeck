import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, NO_REFETCH } from "@/web/api/client";

const environments = api.api.environments[":id"];
const variable = environments.variables[":name"];
const templates = api.api.apps[":appKey"]["variable-templates"];

type PutVariableBody = Parameters<typeof variable.$put>[0]["json"];
type PutTemplateBody = Parameters<
  (typeof templates)[":name"]["$put"]
>[0]["json"];

/** The environment's variables, secret and generated values masked. */
export async function listVariables(environmentId: string) {
  return parseResponse(
    environments.variables.$get({ param: { id: environmentId }, query: {} })
  );
}

export const listVariablesQuery = (environmentId: string) =>
  queryOptions({
    queryKey: ["variables", "listVariables", environmentId],
    queryFn: () => listVariables(environmentId),
  });

/**
 * The same listing with every value decrypted. Not a query on purpose: the
 * values stay in the caller's state only, are never cached, and each call is
 * one recorded reveal (a refetch would record another).
 */
export async function revealVariables(environmentId: string) {
  return parseResponse(
    environments.variables.$get({
      param: { id: environmentId },
      query: { reveal: "1" },
    })
  );
}

export type VariablesListing = Awaited<ReturnType<typeof listVariables>>;
export type VariableRow = VariablesListing["variables"][number];

export async function putVariable(
  environmentId: string,
  name: string,
  body: PutVariableBody
) {
  return parseResponse(
    variable.$put({ param: { id: environmentId, name }, json: body })
  );
}

export async function deleteVariable(environmentId: string, name: string) {
  return parseResponse(
    variable.$delete({ param: { id: environmentId, name } })
  );
}

export async function regenerateVariable(environmentId: string, name: string) {
  return parseResponse(
    variable.regenerate.$post({ param: { id: environmentId, name } })
  );
}

export async function applyVariableTemplate(environmentId: string) {
  return parseResponse(
    environments.variables["apply-template"].$post({
      param: { id: environmentId },
    })
  );
}

const importRoute = environments.variables.import;

type SaveImportBody = Parameters<typeof importRoute.$post>[0]["json"];

/**
 * The "Import .env from server" review: each deploy dir's status and the
 * rows. Every call reads the servers over SSH, so it is not a cached query:
 * the dialog calls it on open and on reload.
 */
export async function readServerImport(environmentId: string) {
  return parseResponse(importRoute.$get({ param: { id: environmentId } }));
}

export type ServerImportReview = Awaited<ReturnType<typeof readServerImport>>;
export type ImportReviewRow = ServerImportReview["rows"][number];
export type ImportReviewDir = ServerImportReview["dirs"][number];

/**
 * The review of pasted or uploaded `.env` text, compared with the stored
 * values server-side. Writes nothing, so it skips the refetch after a POST.
 */
export async function previewTextImport(environmentId: string, text: string) {
  return parseResponse(
    importRoute.preview.$post(
      { param: { id: environmentId }, json: { source: "text", text } },
      NO_REFETCH
    )
  );
}

/** Saves the reviewed rows (`source: "server"` or `"text"`). */
export async function saveImport(environmentId: string, body: SaveImportBody) {
  return parseResponse(
    importRoute.$post({ param: { id: environmentId }, json: body })
  );
}

/**
 * `acknowledgedChanges`: the preview changes the user confirmed when turning
 * it on (recorded in the activity).
 */
export async function setEnvFileManaged(
  environmentId: string,
  enabled: boolean,
  acknowledgedChanges?: number
) {
  return parseResponse(
    environments["env-file-managed"].$patch({
      param: { id: environmentId },
      json:
        acknowledgedChanges === undefined
          ? { enabled }
          : { enabled, acknowledgedChanges },
    })
  );
}

/**
 * The managed `.env` the next deploy would install, diffed per deploy dir
 * against the live file. Every call reads the servers over SSH, so it is not
 * a cached query: the dialog calls it on open.
 */
export async function previewEnvFile(environmentId: string) {
  return parseResponse(
    environments["env-file"].preview.$get({ param: { id: environmentId } })
  );
}

export type EnvFilePreview = Awaited<ReturnType<typeof previewEnvFile>>;
export type EnvFilePreviewDir = EnvFilePreview["dirs"][number];
export type EnvFilePreviewChange = EnvFilePreviewDir["changes"][number];

export async function listVariableTemplates(appKey: string) {
  return parseResponse(templates.$get({ param: { appKey } }));
}

export const listVariableTemplatesQuery = (appKey: string) =>
  queryOptions({
    queryKey: ["variables", "listVariableTemplates", appKey],
    queryFn: () => listVariableTemplates(appKey),
  });

export type VariableTemplateRow = Awaited<
  ReturnType<typeof listVariableTemplates>
>[number];

export async function putVariableTemplate(
  appKey: string,
  name: string,
  body: PutTemplateBody
) {
  return parseResponse(
    templates[":name"].$put({ param: { appKey, name }, json: body })
  );
}

export async function deleteVariableTemplate(appKey: string, name: string) {
  return parseResponse(templates[":name"].$delete({ param: { appKey, name } }));
}
