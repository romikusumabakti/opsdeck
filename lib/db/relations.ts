import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
  servers: {
    dbProjects: r.many.projects({
      from: r.servers.id,
      to: r.projects.dbServerId,
    }),
    backendProjects: r.many.projects({
      from: r.servers.id,
      to: r.projects.backendServerId,
    }),
    frontendProjects: r.many.projects({
      from: r.servers.id,
      to: r.projects.frontendServerId,
    }),
  },
  projects: {
    tasks: r.many.tasks(),
    dbServer: r.one.servers({
      from: r.projects.dbServerId,
      to: r.servers.id,
    }),
    backendServer: r.one.servers({
      from: r.projects.backendServerId,
      to: r.servers.id,
    }),
    frontendServer: r.one.servers({
      from: r.projects.frontendServerId,
      to: r.servers.id,
    }),
  },
  tasks: {
    project: r.one.projects({
      from: r.tasks.projectId,
      to: r.projects.id,
    }),
    user: r.one.users({
      from: r.tasks.userId,
      to: r.users.id,
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
