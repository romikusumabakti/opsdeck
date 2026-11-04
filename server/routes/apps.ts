import { z } from "zod";
import { buildSpecSchema } from "@/lib/ci/build-spec";
import { registerAppSchema } from "@/lib/ci/registration";
import { appKeySchema, componentKeySchema } from "@/lib/deploy/validation";
import { sessionRouter } from "@/server/router";
import {
  listAllApps,
  previewPipeline,
  registerApp,
  retryFallbackCommit,
  rotateNotifySecret,
} from "@/server/services/apps";
import { json, jsonQuery, param } from "@/server/validation";

const componentParam = param(
  z.object({ appKey: appKeySchema, componentKey: componentKeySchema })
);

/**
 * Apps and their components. Listing is for every signed-in user; the rest is
 * for app registrants (admins and project maintainers), checked by each
 * service function.
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
  .post(
    "/:appKey/components/:componentKey/rotate-secret",
    componentParam,
    async (c) => {
      const { appKey, componentKey } = c.req.valid("param");
      return c.json(await rotateNotifySecret(appKey, componentKey));
    }
  )
  .post(
    "/:appKey/components/:componentKey/commit-fallback",
    componentParam,
    async (c) => {
      const { appKey, componentKey } = c.req.valid("param");
      return c.json(await retryFallbackCommit(appKey, componentKey));
    }
  );
