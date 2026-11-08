import { z } from "zod";
import { branchSchema } from "@/lib/deploy/validation";
import { newEnvironmentInputSchema } from "@/lib/setup/new-environment";
import { environmentSetupInputSchema } from "@/lib/setup/schema";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import { listProjectAccessPolicies } from "@/server/services/environment-domains";
import {
  createEnvironmentSetup,
  getCopySource,
  getSetupOptions,
  previewEnvironmentSetup,
} from "@/server/services/environment-setup";
import {
  createNewEnvironment,
  previewNewEnvironment,
  searchSetupRepos,
} from "@/server/services/new-environment";
import { detectComponentRepo } from "@/server/services/setup-detect";
import { json, param, query } from "@/server/validation";

/**
 * The setup wizard's server side. Each service function checks its own
 * permission; detection is for app registrants, environment setup for
 * engineers of the target project.
 */
export const setupRouter = sessionRouter()
  .get(
    "/detect",
    query(
      z.object({
        connectionId: uuidSchema,
        repo: z.string().min(3).max(300),
        branch: branchSchema,
      })
    ),
    async (c) => {
      const { connectionId, repo, branch } = c.req.valid("query");
      return c.json(await detectComponentRepo(connectionId, repo, branch));
    }
  )
  // A POST that writes nothing: the input is a whole setup, too big for a
  // query string. The client sends it with NO_REFETCH (web/api/client).
  .post("/environments/preview", json(environmentSetupInputSchema), async (c) =>
    c.json(await previewEnvironmentSetup(c.req.valid("json")))
  )
  .post("/environments", json(environmentSetupInputSchema), async (c) =>
    c.json(await createEnvironmentSetup(c.req.valid("json")), 201)
  )
  // The New environment page: a short input the server resolves into a
  // setup (preview writes nothing, like /environments/preview).
  .post(
    "/new-environment/preview",
    json(newEnvironmentInputSchema),
    async (c) => c.json(await previewNewEnvironment(c.req.valid("json")))
  )
  .post("/new-environment", json(newEnvironmentInputSchema), async (c) =>
    c.json(await createNewEnvironment(c.req.valid("json")), 201)
  )
  // The repo picker: the CI server's repos by name, each with its owning app.
  .get(
    "/repos",
    query(z.object({ q: z.string().max(200).default("") })),
    async (c) => c.json(await searchSetupRepos(c.req.valid("query").q))
  )
  // The lists the forms offer for a project, without org server or tunnel
  // read (an engineer has neither).
  .get("/options", query(z.object({ projectId: uuidSchema })), async (c) =>
    c.json(await getSetupOptions(c.req.valid("query").projectId))
  )
  // The Access policies for a domain that has no environment yet.
  .get(
    "/access-policies",
    query(z.object({ projectId: uuidSchema })),
    async (c) =>
      c.json(await listProjectAccessPolicies(c.req.valid("query").projectId))
  )
  .get(
    "/environments/copy-source/:id",
    param(z.object({ id: uuidSchema })),
    async (c) => c.json(await getCopySource(c.req.valid("param").id))
  );
