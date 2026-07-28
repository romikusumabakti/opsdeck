import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
  servers: {
    services: r.many.environmentServices({
      from: r.servers.id,
      to: r.environmentServices.serverId,
    }),
  },
  projects: {
    environments: r.many.environments(),
    issues: r.many.issues(),
    milestones: r.many.milestones(),
  },
  environments: {
    project: r.one.projects({
      from: r.environments.projectId,
      to: r.projects.id,
    }),
    runs: r.many.runs(),
    services: r.many.environmentServices({
      from: r.environments.id,
      to: r.environmentServices.environmentId,
    }),
  },
  environmentServices: {
    environment: r.one.environments({
      from: r.environmentServices.environmentId,
      to: r.environments.id,
    }),
    server: r.one.servers({
      from: r.environmentServices.serverId,
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
    comments: r.many.issueComments(),
    parent: r.one.issues({
      from: r.issues.parentId,
      to: r.issues.id,
    }),
    milestone: r.one.milestones({
      from: r.issues.milestoneId,
      to: r.milestones.id,
    }),
    attachments: r.many.issueAttachments(),
  },
  milestones: {
    project: r.one.projects({
      from: r.milestones.projectId,
      to: r.projects.id,
    }),
    issues: r.many.issues(),
  },
  issueAttachments: {
    issue: r.one.issues({
      from: r.issueAttachments.issueId,
      to: r.issues.id,
    }),
    uploadedBy: r.one.users({
      from: r.issueAttachments.uploadedById,
      to: r.users.id,
    }),
  },
  issueComments: {
    issue: r.one.issues({
      from: r.issueComments.issueId,
      to: r.issues.id,
    }),
    author: r.one.users({
      from: r.issueComments.authorId,
      to: r.users.id,
    }),
  },
  runs: {
    environment: r.one.environments({
      from: r.runs.environmentId,
      to: r.environments.id,
    }),
    user: r.one.users({
      from: r.runs.userId,
      to: r.users.id,
    }),
    issue: r.one.issues({
      from: r.runs.issueId,
      to: r.issues.id,
    }),
  },
  users: {
    sessions: r.many.sessions(),
    accounts: r.many.accounts(),
    invitations: r.many.invitations(),
  },
  activityLog: {
    actor: r.one.users({
      from: r.activityLog.actorId,
      to: r.users.id,
    }),
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
