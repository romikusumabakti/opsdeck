import { z } from "zod";
import { getProjectAccess } from "@/lib/authz";
import {
  projectMetaInputSchema,
  projectMetaUpdateSchema,
  uuidSchema,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  addProject,
  editProject,
  getProject,
  getProjectByKeyWithEnvironments,
  getProjectWithEnvironments,
  listProjects,
  listProjectsWithEnvironments,
  removeProject,
} from "@/server/services/project-catalog";
import { json, query } from "@/server/validation";

const byId = query(z.object({ id: uuidSchema }));

// The getters return `undefined` for a missing or invisible project; JSON has
// no undefined, so the routes send `null`.
export const projectCatalogRouter = sessionRouter()
  .get("/list-projects", async (c) => c.json(await listProjects()))
  .get("/list-projects-with-environments", async (c) =>
    c.json(await listProjectsWithEnvironments())
  )
  .get("/get-project", byId, async (c) =>
    c.json((await getProject(c.req.valid("query").id)) ?? null)
  )
  .get("/get-project-with-environments", byId, async (c) =>
    c.json((await getProjectWithEnvironments(c.req.valid("query").id)) ?? null)
  )
  .get(
    "/get-project-by-key-with-environments",
    query(z.object({ key: z.string().trim().min(1).max(32) })),
    async (c) =>
      c.json(
        (await getProjectByKeyWithEnvironments(c.req.valid("query").key)) ??
          null
      )
  )
  // Page data (root layout shell, projects list): the caller's role in each
  // project they can see. Signed-in only, which the session router enforces;
  // getProjectAccess re-checks.
  .get("/my-access", async (c) => c.json(await getProjectAccess()))
  .post(
    "/add-project",
    json(z.object({ data: projectMetaInputSchema })),
    async (c) => c.json(await addProject(c.req.valid("json").data))
  )
  .post(
    "/edit-project",
    json(z.object({ id: uuidSchema, data: projectMetaUpdateSchema })),
    async (c) => {
      const { id, data } = c.req.valid("json");
      return c.json(await editProject(id, data));
    }
  )
  .post("/remove-project", json(z.object({ id: uuidSchema })), async (c) =>
    c.json(await removeProject(c.req.valid("json").id))
  );
