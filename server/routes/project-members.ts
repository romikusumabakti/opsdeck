import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  addProjectMember,
  listMemberCandidates,
  listProjectMembers,
  removeProjectMember,
} from "@/server/services/project-members";
import { json, query } from "@/server/validation";

const byProject = query(z.object({ projectId: uuidSchema }));
const memberInput = z.object({ projectId: uuidSchema, userId: uuidSchema });

export const projectMembersRouter = sessionRouter()
  // One-release compatibility stub: a SPA bundle cached from before the global
  // roles change still calls this endpoint from the Members route loader, and
  // a 404 there fails the whole route until a full reload. Remove with plan
  // Task 6 (drop project_members.role).
  .get("/list-org-wide-access", (c) => c.json([]))
  .get("/list-project-members", byProject, async (c) =>
    c.json(await listProjectMembers(c.req.valid("query").projectId))
  )
  .get("/list-member-candidates", byProject, async (c) =>
    c.json(await listMemberCandidates(c.req.valid("query").projectId))
  )
  .post(
    "/add-project-member",
    json(z.object({ input: memberInput })),
    async (c) => c.json(await addProjectMember(c.req.valid("json").input))
  )
  .post(
    "/remove-project-member",
    json(z.object({ input: memberInput })),
    async (c) => c.json(await removeProjectMember(c.req.valid("json").input))
  );
