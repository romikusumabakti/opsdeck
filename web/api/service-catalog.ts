import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type { BuildSpec } from "@/lib/ci/build-spec";
import { api } from "@/web/api/client";

// Services (Stage 8), addressed by key alone (server/routes/service-catalog.ts).
const routes = api.api["service-catalog"];

export async function listServices() {
  return parseResponse(routes.$get());
}

export const listServicesQuery = () =>
  queryOptions({
    queryKey: ["service-catalog", "listServices"],
    queryFn: listServices,
  });

export type ServiceRow = Awaited<ReturnType<typeof listServices>>[number];

export async function rotateNotifySecret(componentKey: string) {
  return parseResponse(
    routes[":componentKey"]["rotate-secret"].$post({ param: { componentKey } })
  );
}

/** Starts a build of the service's branch (who may: the server's rule). */
export async function startComponentBuild(
  componentKey: string,
  branch: string
) {
  return parseResponse(
    routes[":componentKey"].build.$post({
      param: { componentKey },
      json: { branch },
    })
  );
}

/** The branch's newest running pipeline, or null (who may: the server's rule). */
export async function getActiveBuild(componentKey: string, branch: string) {
  return parseResponse(
    routes[":componentKey"].builds.active.$get({
      param: { componentKey },
      query: { branch },
    })
  );
}

/** Commits the generated pipeline file to every built branch, or to one. */
export async function commitPipelineFile(
  componentKey: string,
  branch?: string
) {
  return parseResponse(
    routes[":componentKey"]["commit-pipeline-file"].$post({
      param: { componentKey },
      query: branch === undefined ? {} : { branch },
    })
  );
}

export async function getPipelinePreview(
  componentKey: string,
  buildSpec: BuildSpec
) {
  return parseResponse(
    routes["pipeline-preview"].$get({
      query: { q: JSON.stringify({ componentKey, buildSpec }) },
    })
  );
}

/** The generated YAML for a valid spec; keeps the last one while typing. */
export const pipelinePreviewQuery = (
  componentKey: string,
  buildSpec: BuildSpec | null
) =>
  queryOptions({
    queryKey: ["service-catalog", "pipelinePreview", componentKey, buildSpec],
    queryFn: () => getPipelinePreview(componentKey, buildSpec as BuildSpec),
    enabled: buildSpec !== null,
    placeholderData: keepPreviousData,
  });
