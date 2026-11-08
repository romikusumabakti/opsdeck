import { z } from "zod";
import { buildSpecSchema } from "@/lib/ci/build-spec";
import { registerAppSchema } from "@/lib/ci/registration";
import {
  appKeySchema,
  branchSchema,
  componentKeySchema,
} from "@/lib/deploy/validation";
import { sessionRouter } from "@/server/router";
import {
  listAllApps,
  previewPipeline,
  registerApp,
  retryPipelineFileCommit,
  rotateNotifySecret,
  triggerComponentBuild,
} from "@/server/services/apps";
import { json, jsonQuery, param, query } from "@/server/validation";

const componentParam = param(
  z.object({ appKey: appKeySchema, componentKey: componentKeySchema })
);

/**
 * Apps and their components. Listing is for every signed-in user; registering
 * is for app registrants (admins and project engineers; generated pipelines
 * for admins only); starting a build is for admins and project engineers
 * (see triggerComponentBuild); rotating a notify secret and committing the
 * pipeline file are for admins. Each service function checks its own
 * permission.
 */
export const appsRouter = sessionRouter()
  .get("/", async (c) => c.json(await listAllApps()))
  .post("/", json(registerAppSchema), async (c) =>
    c.json(await registerApp(c.req.valid("json")), 201)
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
  // Starts a build; the New app stepper's first one. Who may is the service's.
  .post(
    "/:appKey/components/:componentKey/build",
    componentParam,
    json(z.object({ branch: branchSchema })),
    async (c) => {
      const { appKey, componentKey } = c.req.valid("param");
      const { branch } = c.req.valid("json");
      return c.json(await triggerComponentBuild(appKey, componentKey, branch));
    }
  )
  .post(
    "/:appKey/components/:componentKey/rotate-secret",
    componentParam,
    async (c) => {
      const { appKey, componentKey } = c.req.valid("param");
      return c.json(await rotateNotifySecret(appKey, componentKey));
    }
  )
  // Every built branch, or only `?branch=`.
  .post(
    "/:appKey/components/:componentKey/commit-pipeline-file",
    componentParam,
    query(z.object({ branch: branchSchema.optional() })),
    async (c) => {
      const { appKey, componentKey } = c.req.valid("param");
      const { branch } = c.req.valid("query");
      return c.json(
        await retryPipelineFileCommit(appKey, componentKey, branch)
      );
    }
  );
