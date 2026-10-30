import { z } from "zod";
import { testRunSchema, uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import { listIssueTestRuns, recordTestRun } from "@/server/services/test-runs";
import { json, query } from "@/server/validation";

export const testRunsRouter = sessionRouter()
  .get(
    "/list-issue-test-runs",
    query(z.object({ issueId: uuidSchema })),
    async (c) => c.json(await listIssueTestRuns(c.req.valid("query").issueId))
  )
  .post(
    "/record-test-run",
    json(z.object({ data: testRunSchema })),
    async (c) => c.json(await recordTestRun(c.req.valid("json").data))
  );
