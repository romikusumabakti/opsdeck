import { z } from "zod";
import { milestoneInputSchema, uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  createMilestone,
  deleteMilestone,
  listMilestones,
  setMilestoneClosed,
  updateMilestone,
} from "@/server/services/milestones";
import { json, query } from "@/server/validation";

export const milestonesRouter = sessionRouter()
  .get(
    "/list-milestones",
    query(z.object({ projectId: uuidSchema })),
    async (c) => c.json(await listMilestones(c.req.valid("query").projectId))
  )
  .post(
    "/create-milestone",
    json(z.object({ data: milestoneInputSchema })),
    async (c) => c.json(await createMilestone(c.req.valid("json").data))
  )
  .post(
    "/update-milestone",
    // The service applies the same partial schema.
    json(z.object({ id: uuidSchema, data: milestoneInputSchema.partial() })),
    async (c) => {
      const { id, data } = c.req.valid("json");
      return c.json(await updateMilestone(id, data));
    }
  )
  .post(
    "/set-milestone-closed",
    json(z.object({ id: uuidSchema, closed: z.boolean() })),
    async (c) => {
      const { id, closed } = c.req.valid("json");
      return c.json(await setMilestoneClosed(id, closed));
    }
  )
  .post("/delete-milestone", json(z.object({ id: uuidSchema })), async (c) =>
    c.json(await deleteMilestone(c.req.valid("json").id))
  );
