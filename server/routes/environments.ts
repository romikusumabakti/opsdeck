import { z } from "zod";
import { requireProjectPage } from "@/lib/authz";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import {
  environmentInputSchema,
  environmentUpdateSchema,
  uuidSchema,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  createEnvironment,
  deleteEnvironment,
  getEnvironmentById,
  getEnvironmentsLastOpened,
  listEnvironments,
  recordEnvironmentAccess,
  updateEnvironment,
} from "@/server/services/environments";
import { json, query } from "@/server/validation";

export const environmentsRouter = sessionRouter()
  .get("/list-environments", async (c) => c.json(await listEnvironments()))
  .get("/get-environments-last-opened", async (c) =>
    c.json(await getEnvironmentsLastOpened())
  )
  .get(
    "/get-environment-by-id",
    query(z.object({ id: uuidSchema })),
    async (c) =>
      c.json((await getEnvironmentById(c.req.valid("query").id)) ?? null)
  )
  /**
   * Page data for every `/[projectKey]/[envSlug]/**` page: the readable URL
   * resolved to its environment id, plus the caller's role in its project
   * (the layout's ProjectRoleProvider). Same guard the layout applied — 404
   * when the key/slug don't match or the project is invisible to the caller.
   */
  .get(
    "/resolve",
    query(
      z.object({
        projectKey: z.string().trim().min(1).max(32),
        envSlug: z.string().trim().min(1).max(64),
      })
    ),
    async (c) => {
      const { projectKey, envSlug } = c.req.valid("query");
      const environmentId = await resolveEnvIdByKeySlug(projectKey, envSlug);
      const { role } = await requireProjectPage({ environmentId });
      return c.json({ environmentId, role });
    }
  )
  .post(
    "/record-environment-access",
    json(z.object({ environmentId: uuidSchema })),
    async (c) => {
      await recordEnvironmentAccess(c.req.valid("json").environmentId);
      return c.json(null);
    }
  )
  .post(
    "/create-environment",
    json(z.object({ data: environmentInputSchema })),
    async (c) => c.json(await createEnvironment(c.req.valid("json").data))
  )
  .post(
    "/update-environment",
    json(z.object({ id: uuidSchema, data: environmentUpdateSchema })),
    async (c) => {
      const { id, data } = c.req.valid("json");
      return c.json(await updateEnvironment(id, data));
    }
  )
  .post("/delete-environment", json(z.object({ id: uuidSchema })), async (c) =>
    c.json(await deleteEnvironment(c.req.valid("json").id))
  );
