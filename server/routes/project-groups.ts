import { z } from "zod";
import {
  projectGroupInputSchema,
  projectGroupMergeSchema,
  projectGroupReorderSchema,
  uuidSchema,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  createGroup,
  deleteGroup,
  listGroups,
  mergeGroups,
  renameGroup,
  reorderGroup,
} from "@/server/services/project-groups";
import { json } from "@/server/validation";

// Project groups. Listing is for every role that works with projects; the
// writes are the services' (org project:create) to guard.
export const projectGroupsRouter = sessionRouter()
  .get("/list-groups", async (c) => c.json(await listGroups()))
  .post("/create-group", json(projectGroupInputSchema), async (c) =>
    c.json(await createGroup(c.req.valid("json")))
  )
  .post(
    "/rename-group",
    json(projectGroupInputSchema.extend({ id: uuidSchema })),
    async (c) => {
      const { id, ...data } = c.req.valid("json");
      return c.json(await renameGroup(id, data));
    }
  )
  .post(
    "/reorder-group",
    json(projectGroupReorderSchema.extend({ id: uuidSchema })),
    async (c) => {
      const { id, ...position } = c.req.valid("json");
      return c.json(await reorderGroup(id, position));
    }
  )
  .post("/merge-groups", json(projectGroupMergeSchema), async (c) =>
    c.json(await mergeGroups(c.req.valid("json")))
  )
  .post("/delete-group", json(z.object({ id: uuidSchema })), async (c) =>
    c.json(await deleteGroup(c.req.valid("json").id))
  );
