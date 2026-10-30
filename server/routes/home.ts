import { z } from "zod";
import {
  getAttentionGroups,
  getHomeAccess,
  listIssueProjects,
  listMyOpenIssues,
  listRecentEnvironments,
} from "@/lib/home/queries";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  acknowledgeAttentionGroup,
  unacknowledgeRuns,
} from "@/server/services/home";
import { json } from "@/server/validation";

// The reads are Home's page data, served straight from lib/home/queries. The
// page needed only a session (the session router), and each query scopes its
// rows to the caller's projects itself. They throw on a DB failure, so the
// client renders a per-card error instead of a misleading empty state.
export const homeRouter = sessionRouter()
  .get("/attention-groups", async (c) => c.json(await getAttentionGroups()))
  .get("/my-open-issues", async (c) => c.json(await listMyOpenIssues()))
  .get("/recent-environments", async (c) =>
    c.json(await listRecentEnvironments())
  )
  .get("/issue-projects", async (c) => c.json(await listIssueProjects()))
  .get("/access", async (c) => c.json(await getHomeAccess()))
  .post(
    "/acknowledge-attention-group",
    json(
      z.object({ environmentId: uuidSchema, key: z.string().trim().max(1000) })
    ),
    async (c) => {
      const { environmentId, key } = c.req.valid("json");
      return c.json(await acknowledgeAttentionGroup(environmentId, key));
    }
  )
  .post(
    "/unacknowledge-runs",
    json(
      z.object({
        environmentId: uuidSchema,
        runIds: z.array(uuidSchema).min(1).max(500),
      })
    ),
    async (c) => {
      const { environmentId, runIds } = c.req.valid("json");
      return c.json(await unacknowledgeRuns(environmentId, runIds));
    }
  );
