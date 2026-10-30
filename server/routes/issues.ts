import { z } from "zod";
import { ISSUE_SORTS } from "@/lib/issue-query";
import {
  issueInputSchema,
  issueStatusSchema,
  issueUpdateSchema,
  uuidSchema,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  addComment,
  bulkDeleteIssues,
  bulkSetStatus,
  createIssue,
  deleteIssue,
  getAssignedIssueCounts,
  getIssueDetail,
  getIssueFormOptions,
  getOpenIssueCounts,
  listAllIssues,
  listIssues,
  setIssueStatus,
  updateIssue,
} from "@/server/services/issues";
import { json, jsonQuery, query } from "@/server/validation";

// Bulk triage acts on what one list page shows (at most 200 rows); the cap
// keeps a crafted request from naming the whole table.
const issueIds = z.array(uuidSchema).max(500);

// Filter values come straight from the issues page URL. The service ignores a
// junk status/priority/id rather than failing the page, so those stay loose
// strings here; only the shape and the sort column (a SQL mapping key) are
// enforced.
const filter = z.string().max(200).optional();
const issueQuerySchema = z.object({
  q: filter,
  status: filter,
  projectId: filter,
  labelId: filter,
  priority: filter,
  assigneeId: filter,
  sort: z.enum(ISSUE_SORTS).optional(),
  desc: z.boolean().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});

export const issuesRouter = sessionRouter()
  .get("/get-open-issue-counts", async (c) =>
    c.json(await getOpenIssueCounts())
  )
  .get("/get-assigned-issue-counts", async (c) =>
    c.json(await getAssignedIssueCounts())
  )
  .get(
    "/get-issue-detail",
    query(
      z.object({
        projectKey: z.string().trim().min(1).max(32),
        number: z.coerce.number().int().positive(),
      })
    ),
    async (c) => {
      const { projectKey, number } = c.req.valid("query");
      return c.json(await getIssueDetail(projectKey, number));
    }
  )
  .get("/list-all-issues", jsonQuery(issueQuerySchema), async (c) =>
    c.json(await listAllIssues(c.req.valid("query")))
  )
  .get("/list-issues", query(z.object({ projectId: uuidSchema })), async (c) =>
    c.json(await listIssues(c.req.valid("query").projectId))
  )
  .get(
    "/get-issue-form-options",
    query(z.object({ projectId: uuidSchema })),
    async (c) =>
      c.json(await getIssueFormOptions(c.req.valid("query").projectId))
  )
  .post(
    "/add-comment",
    // Length is the service's call: it answers with a message the form shows.
    json(z.object({ issueId: uuidSchema, body: z.string().max(100_000) })),
    async (c) => {
      const { issueId, body } = c.req.valid("json");
      return c.json(await addComment(issueId, body));
    }
  )
  .post(
    "/create-issue",
    json(z.object({ data: issueInputSchema })),
    async (c) => c.json(await createIssue(c.req.valid("json").data))
  )
  .post(
    "/update-issue",
    json(z.object({ id: uuidSchema, data: issueUpdateSchema })),
    async (c) => {
      const { id, data } = c.req.valid("json");
      return c.json(await updateIssue(id, data));
    }
  )
  .post(
    "/set-issue-status",
    json(z.object({ id: uuidSchema, status: issueStatusSchema })),
    async (c) => {
      const { id, status } = c.req.valid("json");
      return c.json(await setIssueStatus(id, status));
    }
  )
  .post(
    "/bulk-set-status",
    json(z.object({ ids: issueIds, status: issueStatusSchema })),
    async (c) => {
      const { ids, status } = c.req.valid("json");
      return c.json(await bulkSetStatus(ids, status));
    }
  )
  .post("/bulk-delete-issues", json(z.object({ ids: issueIds })), async (c) =>
    c.json(await bulkDeleteIssues(c.req.valid("json").ids))
  )
  .post("/delete-issue", json(z.object({ id: uuidSchema })), async (c) =>
    c.json(await deleteIssue(c.req.valid("json").id))
  );
