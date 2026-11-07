import { z } from "zod";
import { branchSchema } from "@/lib/deploy/validation";
import { environmentSetupInputSchema } from "@/lib/setup/schema";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  createEnvironmentSetup,
  getCopySource,
  previewEnvironmentSetup,
} from "@/server/services/environment-setup";
import { detectComponentRepo } from "@/server/services/setup-detect";
import { json, param, query } from "@/server/validation";

/**
 * The setup wizard's server side. Each service function checks its own
 * permission; detection is for app registrants, environment setup for
 * maintainers of the target project.
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
  .get(
    "/environments/copy-source/:id",
    param(z.object({ id: uuidSchema })),
    async (c) => c.json(await getCopySource(c.req.valid("param").id))
  );
