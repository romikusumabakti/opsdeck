import { z } from "zod";
import { branchSchema, componentKeySchema } from "@/lib/deploy/validation";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  addProjectSource,
  listProjectSources,
  removeProjectSource,
  setComponentBranch,
} from "@/server/services/project-sources";
import { json, query } from "@/server/validation";

const sourceInput = z.object({ projectId: uuidSchema, appId: uuidSchema });

export const projectSourcesRouter = sessionRouter()
  .get(
    "/list-project-sources",
    query(z.object({ projectId: uuidSchema })),
    async (c) =>
      c.json(await listProjectSources(c.req.valid("query").projectId))
  )
  .post(
    "/add-project-source",
    json(z.object({ input: sourceInput })),
    async (c) => c.json(await addProjectSource(c.req.valid("json").input))
  )
  .post(
    "/remove-project-source",
    json(z.object({ input: sourceInput })),
    async (c) => c.json(await removeProjectSource(c.req.valid("json").input))
  )
  .post(
    "/set-component-branch",
    json(
      z.object({
        input: z.object({
          projectId: uuidSchema,
          componentKey: componentKeySchema,
          branch: branchSchema,
        }),
      })
    ),
    async (c) => c.json(await setComponentBranch(c.req.valid("json").input))
  );
