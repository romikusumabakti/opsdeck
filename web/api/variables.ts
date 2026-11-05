import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

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

export async function setEnvFileManaged(
  environmentId: string,
  enabled: boolean
) {
  return parseResponse(
    environments["env-file-managed"].$patch({
      param: { id: environmentId },
      json: { enabled },
    })
  );
}

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
