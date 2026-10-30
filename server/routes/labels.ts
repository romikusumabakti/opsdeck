import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import { listLabels, setIssueLabels } from "@/server/services/labels";
import { json } from "@/server/validation";

export const labelsRouter = sessionRouter()
  .get("/list-labels", async (c) => c.json(await listLabels()))
  .post(
    "/set-issue-labels",
    json(
      z.object({
        issueId: uuidSchema,
        labelIds: z.array(uuidSchema).max(100),
      })
    ),
    async (c) => {
      const { issueId, labelIds } = c.req.valid("json");
      return c.json(await setIssueLabels(issueId, labelIds));
    }
  );
