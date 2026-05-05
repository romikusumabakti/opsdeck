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
  users: {
    sessions: r.many.sessions(),
    accounts: r.many.accounts(),
    invitations: r.many.invitations(),
  },
  sessions: {
    user: r.one.users({
      from: r.sessions.userId,
      to: r.users.id,
    }),
  },
  accounts: {
    user: r.one.users({
      from: r.accounts.userId,
      to: r.users.id,
    }),
  },
  invitations: {
    invitedBy: r.one.users({
      from: r.invitations.invitedById,
      to: r.users.id,
    }),
  },
}));
