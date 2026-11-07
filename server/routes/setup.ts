import { z } from "zod";
import { branchSchema } from "@/lib/deploy/validation";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import { detectComponentRepo } from "@/server/services/setup-detect";
import { query } from "@/server/validation";

/**
 * The setup wizard's server side. Each service function checks its own
 * permission; detection is for app registrants.
 */
export const setupRouter = sessionRouter().get(
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
);
