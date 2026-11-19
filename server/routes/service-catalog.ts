import { z } from "zod";
import { buildSpecSchema } from "@/lib/ci/build-spec";
import { registerServicesSchema } from "@/lib/ci/registration";
import { branchSchema, componentKeySchema } from "@/lib/deploy/validation";
import { sessionRouter } from "@/server/router";
import {
  getActiveComponentBuild,
  listAllServices,
  previewPipeline,
  registerServices,
  retryPipelineFileCommit,
  rotateNotifySecret,
  triggerComponentBuild,
} from "@/server/services/apps";
import { json, jsonQuery, param, query } from "@/server/validation";

const serviceParam = param(z.object({ componentKey: componentKeySchema }));

/**
 * Services (Stage 8; the rows of `app_components`), addressed by their key
 * alone, with or without a legacy app. Listing is for every signed-in user who
 * works with projects; registering is for registrants (admins and project
 * engineers; generated pipelines for admins only); starting a build is for
 * admins and project engineers (see triggerComponentBuild); reading a
 * branch's running build is for whoever views that branch's deploys (see
 * getActiveComponentBuild); rotating a notify secret and committing the
 * pipeline file are for admins. Each service function checks its own
 * permission. Replaces `/api/apps/:appKey/components/:componentKey/*`.
 */
export const serviceCatalogRouter = sessionRouter()
  .get("/", async (c) => c.json(await listAllServices()))
  .post("/", json(registerServicesSchema), async (c) =>
    c.json(await registerServices(c.req.valid("json")), 201)
  )
  // A read with a structured argument, so it travels as `q` (see jsonQuery).
  .get(
    "/pipeline-preview",
    jsonQuery(
      z.object({ componentKey: componentKeySchema, buildSpec: buildSpecSchema })
    ),
    async (c) => {
      const { componentKey, buildSpec } = c.req.valid("query");
      return c.json(await previewPipeline(componentKey, buildSpec));
    }
  )
  .post(
    "/:componentKey/build",
    serviceParam,
    json(z.object({ branch: branchSchema })),
    async (c) => {
      const { componentKey } = c.req.valid("param");
      const { branch } = c.req.valid("json");
      return c.json(await triggerComponentBuild(componentKey, branch));
    }
  )
  // The branch's newest running pipeline, or null.
  .get(
    "/:componentKey/builds/active",
    serviceParam,
    query(z.object({ branch: branchSchema })),
    async (c) => {
      const { componentKey } = c.req.valid("param");
      const { branch } = c.req.valid("query");
      return c.json(await getActiveComponentBuild(componentKey, branch));
    }
  )
  .post("/:componentKey/rotate-secret", serviceParam, async (c) => {
    const { componentKey } = c.req.valid("param");
    return c.json(await rotateNotifySecret(componentKey));
  })
  // Every built branch, or only `?branch=`.
  .post(
    "/:componentKey/commit-pipeline-file",
    serviceParam,
    query(z.object({ branch: branchSchema.optional() })),
    async (c) => {
      const { componentKey } = c.req.valid("param");
      const { branch } = c.req.valid("query");
      return c.json(await retryPipelineFileCommit(componentKey, branch));
    }
  );
