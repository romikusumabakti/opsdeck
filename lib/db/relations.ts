import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
  servers: {
    dbEnvironments: r.many.environments({
      from: r.servers.id,
      to: r.environments.dbServerId,
    }),
    backendEnvironments: r.many.environments({
      from: r.servers.id,
      to: r.environments.backendServerId,
    }),
    frontendEnvironments: r.many.environments({
      from: r.servers.id,
      to: r.environments.frontendServerId,
    }),
  },
  projects: {
    environments: r.many.environments(),
    issues: r.many.issues(),
  },
  environments: {
    project: r.one.projects({
      from: r.environments.projectId,
      to: r.projects.id,
    }),
    runs: r.many.runs(),
    dbServer: r.one.servers({
      from: r.environments.dbServerId,
      to: r.servers.id,
    }),
    backendServer: r.one.servers({
      from: r.environments.backendServerId,
      to: r.servers.id,
    }),
    frontendServer: r.one.servers({
      from: r.environments.frontendServerId,
      to: r.servers.id,
    }),
  },
  issues: {
    project: r.one.projects({
      from: r.issues.projectId,
      to: r.projects.id,
    }),
    environment: r.one.environments({
      from: r.issues.environmentId,
      to: r.environments.id,
    }),
    createdBy: r.one.users({
      from: r.issues.createdById,
      to: r.users.id,
    }),
    assignee: r.one.users({
      from: r.issues.assigneeId,
      to: r.users.id,
    }),
  },
  runs: {
    environment: r.one.environments({
      from: r.runs.projectId,
      to: r.environments.id,
    }),
    user: r.one.users({
      from: r.runs.userId,
      to: r.users.id,
    }),
  },
  users: {
    sessions: r.many.sessions(),
    accounts: r.many.accounts(),
    invitations: r.many.invitations(),
  },
  knowledgeCollections: {
    documents: r.many.knowledgeDocuments(),
    createdBy: r.one.users({
      from: r.knowledgeCollections.createdById,
      to: r.users.id,
    }),
  },
  knowledgeDocuments: {
    collection: r.one.knowledgeCollections({
      from: r.knowledgeDocuments.collectionId,
      to: r.knowledgeCollections.id,
    }),
    parent: r.one.knowledgeDocuments({
      from: r.knowledgeDocuments.parentId,
      to: r.knowledgeDocuments.id,
    }),
    project: r.one.projects({
      from: r.knowledgeDocuments.projectId,
      to: r.projects.id,
    }),
    createdBy: r.one.users({
      from: r.knowledgeDocuments.createdById,
      to: r.users.id,
    }),
    updatedBy: r.one.users({
      from: r.knowledgeDocuments.updatedById,
      to: r.users.id,
    }),
    revisions: r.many.knowledgeRevisions(),
  },
  knowledgeRevisions: {
    document: r.one.knowledgeDocuments({
      from: r.knowledgeRevisions.documentId,
      to: r.knowledgeDocuments.id,
    }),
    editedBy: r.one.users({
      from: r.knowledgeRevisions.editedById,
      to: r.users.id,
    }),
  },
  knowledgeAttachments: {
    uploadedBy: r.one.users({
      from: r.knowledgeAttachments.uploadedById,
      to: r.users.id,
    }),
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
