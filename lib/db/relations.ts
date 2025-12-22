import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
  projects: {
    tasks: r.many.tasks(),
  },
  tasks: {
    project: r.one.projects({
      from: r.tasks.projectId,
      to: r.projects.id,
    }),
  },
}));
