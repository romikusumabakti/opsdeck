import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const serviceTypeEnum = pgEnum("service_type", [
  "docker",
  "systemd",
  "kubernetes",
]);
export const databaseTypeEnum = pgEnum("database_type", ["postgres", "mssql"]);

// All IDs use UUIDv7 (RFC 9562, May 2024) — time-ordered random UUIDs that
// preserve B-tree index locality unlike v4. Default value uses Postgres 18's
// built-in `uuidv7()` function for tables we own; better-auth tables generate
// IDs in JS via `uuid` package (configured in lib/auth.ts).

export const servers = pgTable("servers", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),
  host: text("host").notNull(),
  username: text("username").notNull(),
  password: text("password").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    name: text("name").notNull(),

    // --- Database ---
    dbServerId: uuid("db_server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    dbServiceType: serviceTypeEnum("db_service_type").notNull(),
    dbServiceName: text("db_service_name").notNull(),
    dbType: databaseTypeEnum("db_type").notNull(),
    dbName: text("db_name").notNull(),
    // Required for mssql (sqlcmd needs `sa` password); unused for postgres which
    // relies on trusted local auth (`-U postgres`) inside the container.
    dbPassword: text("db_password"),
    // Where backup files live. Interpretation depends on dbServiceType:
    // docker/kubernetes — path inside the container/pod (bind-mount and PVC
    // configuration are the operator's concern); systemd — path on the host
    // filesystem, which must be writable by the DB's OS user (postgres/mssql).
    dbBackupPath: text("db_backup_path").notNull(),

    // --- Backend ---
    backendServerId: uuid("backend_server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    backendServiceType: serviceTypeEnum("backend_service_type").notNull(),
    backendServiceName: text("backend_service_name").notNull(),
    // URL of the project's clock resource (e.g. `https://api.example.com/v1/clock`).
    // When set, the time-mocking feature talks to this REST API
    // (GET/DELETE the URL itself, POST to `/travel`, `/freeze`, `/advance`)
    // per docs/time-mocking-api.md. When unset, falls back to the legacy
    // `date -s` + service restart approach.
    backendMockTimeApiUrl: text("backend_mock_time_api_url"),
    // Optional API key sent as the `X-Api-Key` header on every mock-time API
    // request. Leave null when the endpoint is unauthenticated.
    backendMockTimeApiKey: text("backend_mock_time_api_key"),

    // --- Frontend ---
    frontendServerId: uuid("frontend_server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    frontendServiceType: serviceTypeEnum("frontend_service_type").notNull(),
    frontendServiceName: text("frontend_service_name").notNull(),
  },
  (t) => [
    // FK columns are filtered/joined on every server-usage lookup and the
    // onDelete:restrict checks; index them so those don't seq-scan `projects`.
    index("projects_db_server_idx").on(t.dbServerId),
    index("projects_backend_server_idx").on(t.backendServerId),
    index("projects_frontend_server_idx").on(t.frontendServerId),
  ]
);

export const taskStatusEnum = pgEnum("task_status", [
  "started",
  "success",
  "failed",
]);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Nullable + set null on user delete: preserve audit history even after the
    // initiating user is removed. UI shows "Unknown" when null.
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    description: text("description").notNull(),
    status: taskStatusEnum("status").notNull().default("started"),
    // Streaming log appended by Inngest steps via appendTaskOutput. Lines are
    // separated by `\n`; the SSE endpoint emits the full snapshot on each tick.
    output: text("output").notNull().default(""),
    errorMessage: text("error_message"),
    runAt: timestamp("run_at").notNull(),
    // Null while still running. Set once status transitions to success/failed.
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    // Every task query filters by projectId and orders by runAt desc
    // (getProjectTasks, getProjectKpis, findLatestByKind, DISTINCT ON).
    index("tasks_project_run_idx").on(t.projectId, t.runAt.desc()),
    // getRunningTasks filters status='started'.
    index("tasks_status_idx").on(t.status),
  ]
);

// =========================
// Auth (better-auth) tables
// =========================

// `role`, `banned`, `banReason`, `banExpires` are managed by the better-auth
// admin plugin (lib/auth.ts). Default role for invited users is "member"; the
// bootstrap user created in `createInitialUser` is promoted to "admin".
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("member"),
  banned: boolean("banned").notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // Set by the admin plugin during impersonation; null on normal sessions.
    impersonatedBy: uuid("impersonated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // better-auth resolves the session by userId on every authenticated request.
    index("sessions_user_idx").on(t.userId),
  ]
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // accountId/providerId are external identifiers (provider's user id, OAuth
    // provider name) — keep as text since they're not always UUID-shaped.
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // better-auth looks up the credential account by userId on sign-in / linking.
    index("accounts_user_idx").on(t.userId),
  ]
);

export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// =========================
// Custom: invitations
// =========================

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    email: text("email").notNull(),
    name: text("name").notNull(),
    // The role assigned to the user upon accepting the invitation. Validated
    // against ROLE_ADMIN/ROLE_MEMBER in actions/users.ts.
    role: text("role").notNull().default("member"),
    // token is a separate random secret used in the invite URL — keep as text.
    token: text("token").notNull().unique(),
    invitedById: uuid("invited_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // inviteUser looks up existing invites by email before issuing a new one.
    index("invitations_email_idx").on(t.email),
  ]
);

// =========================
// Team Knowledge Base
// =========================

// Postgres `tsvector` has no first-class Drizzle column type. This custom type
// maps it so the generated FTS column and its GIN index live in the schema and
// migrations rather than hand-written SQL drift.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// Top-level grouping for documents (e.g. "Runbooks", "Onboarding"). Managing
// collections is admin-only; documents inside are member-editable.
export const knowledgeCollections = pgTable("knowledge_collections", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),
  // lucide-react icon name, rendered in the tree. Null falls back to a default.
  icon: text("icon"),
  description: text("description"),
  // Sibling ordering among collections via a fractional-index rank string —
  // inserting between two ranks never renumbers neighbours. The column is
  // C-collated (see migration) so byte order matches the rank alphabet.
  rank: text("rank").notNull(),
  createdById: uuid("created_by_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => knowledgeCollections.id, { onDelete: "cascade" }),
    // Self-reference builds the nesting tree. set null (not cascade) so deleting
    // a parent re-parents children to the collection root instead of nuking the
    // whole subtree — the actions layer decides reparent vs cascade explicitly.
    parentId: uuid("parent_id").references((): any => knowledgeDocuments.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    // URL-friendly identifier, unique within a collection. Routed as
    // /knowledge/<slug>.
    slug: text("slug").notNull(),
    // Markdown source of truth — portable, diffable, vendor-neutral. TipTap is
    // only the editing surface; persistence is plain markdown.
    content: text("content").notNull().default(""),
    // Plain-text projection of `content`, computed in the actions layer. Feeds
    // the generated search vector; keeps markdown punctuation out of the index.
    contentText: text("content_text").notNull().default(""),
    // Generated full-text vector: title weighted 'A', body 'B'. STORED so the
    // GIN index covers it without a trigger. Recomputed by Postgres on write.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      (): any =>
        sql`setweight(to_tsvector('simple', coalesce(${knowledgeDocuments.title}, '')), 'A') || setweight(to_tsvector('simple', coalesce(${knowledgeDocuments.contentText}, '')), 'B')`
    ),
    // Sibling ordering within the same parent via a fractional-index rank
    // string (C-collated, see migration) — insert-between never renumbers.
    rank: text("rank").notNull(),
    // Optimistic-concurrency token. Bumped on every title/content write; the
    // update action guards on the version the editor loaded so two concurrent
    // edits can't silently overwrite each other (the loser is told to reload).
    version: integer("version").notNull().default(0),
    // Null = draft (author/admin-only visibility); set on publish.
    publishedAt: timestamp("published_at"),
    // Optional link to a project so a runbook can surface in project context.
    // set null: the doc outlives the project (standalone KB is primary).
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedById: uuid("updated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Tree render reads a collection's docs ordered by (parent, rank).
    index("knowledge_documents_tree_idx").on(
      t.collectionId,
      t.parentId,
      t.rank
    ),
    // Routing resolves a doc by slug; globally unique so a `/knowledge/<slug>`
    // link in a body resolves to exactly one document (no cross-collection
    // ambiguity in the backlink graph).
    uniqueIndex("knowledge_documents_slug_idx").on(t.slug),
    // FTS ranking scans the generated vector.
    index("knowledge_documents_search_idx").using("gin", t.searchVector),
    // Inbound-link / project-context lookups.
    index("knowledge_documents_project_idx").on(t.projectId),
  ]
);

// Append-only history. Every update snapshots the PRIOR markdown before the
// write (in a transaction) so any revision can be restored.
export const knowledgeRevisions = pgTable(
  "knowledge_revisions",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    editedById: uuid("edited_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // History page lists a document's revisions newest-first.
    index("knowledge_revisions_document_idx").on(
      t.documentId,
      t.createdAt.desc()
    ),
  ]
);

// Backlink graph: an edge per internal /knowledge link found in a doc's body.
// Rebuilt on every save. PK is the pair so re-saving is an idempotent upsert.
export const knowledgeLinks = pgTable(
  "knowledge_links",
  {
    fromDocumentId: uuid("from_document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    toDocumentId: uuid("to_document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.fromDocumentId, t.toDocumentId] }),
    // "Referenced by" panel queries inbound edges.
    index("knowledge_links_to_idx").on(t.toDocumentId),
  ]
);

// Image/file attachments uploaded from the editor. Bytes live in object storage
// (Garage); this row is the metadata + the stable id the markdown body links to
// via /api/knowledge/asset/<id>. No automatic GC yet: rows/objects outlive their
// document (set null below), so unreferenced uploads accumulate slowly — prune
// out-of-band if it ever matters for an internal tool this size.
export const knowledgeAttachments = pgTable(
  "knowledge_attachments",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // Null until the host document is first saved — an upload can land before
    // the doc row exists. set null (not cascade) keeps the asset usable if a
    // doc is removed but the bytes are still referenced elsewhere.
    documentId: uuid("document_id").references(() => knowledgeDocuments.id, {
      onDelete: "set null",
    }),
    // Object key in the bucket, e.g. "kb/<uuid>.webp". Server-generated; never
    // user input, so no path-traversal surface.
    storageKey: text("storage_key").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedById: uuid("uploaded_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("knowledge_attachments_document_idx").on(t.documentId)]
);

export type KnowledgeCollection = InferSelectModel<typeof knowledgeCollections>;
export type NewKnowledgeCollection = InferInsertModel<
  typeof knowledgeCollections
>;

export type KnowledgeDocument = InferSelectModel<typeof knowledgeDocuments>;
export type NewKnowledgeDocument = InferInsertModel<typeof knowledgeDocuments>;

export type KnowledgeRevision = InferSelectModel<typeof knowledgeRevisions>;
export type NewKnowledgeRevision = InferInsertModel<typeof knowledgeRevisions>;

export type KnowledgeAttachment = InferSelectModel<typeof knowledgeAttachments>;
export type NewKnowledgeAttachment = InferInsertModel<
  typeof knowledgeAttachments
>;

// A document plus its author display names and resolved relations, as shown in
// the reader. Credential-free already — KB has no secrets.
export type KnowledgeDocumentWithMeta = KnowledgeDocument & {
  collection: Pick<KnowledgeCollection, "id" | "name" | "icon">;
  createdBy: Pick<User, "id" | "name"> | null;
  updatedBy: Pick<User, "id" | "name"> | null;
};

// Lightweight node for the navigation tree — no body, no FTS columns.
export type KnowledgeTreeNode = Pick<
  KnowledgeDocument,
  "id" | "collectionId" | "parentId" | "title" | "slug" | "rank"
> & { publishedAt: Date | null };

export type Server = InferSelectModel<typeof servers>;
export type NewServer = InferInsertModel<typeof servers>;

export type Project = InferSelectModel<typeof projects>;
export type NewProject = InferInsertModel<typeof projects>;

export type ProjectWithServers = Project & {
  dbServer: Server;
  backendServer: Server;
  frontendServer: Server;
};

// Credential-free projections handed to the client. SSH passwords, the mssql
// `sa` password, and the mock-time API key must never cross the server/client
// boundary (RSC payloads are visible in the browser). Server code loads the
// full `ProjectWithServers` via lib/projects#loadProjectWithServers; anything
// passed to a client component must be sanitized to these shapes first.
export type SafeServer = Omit<Server, "password">;

export type SafeProjectWithServers = Omit<
  Project,
  "dbPassword" | "backendMockTimeApiKey"
> & {
  dbServer: SafeServer;
  backendServer: SafeServer;
  frontendServer: SafeServer;
  // Presence flags let edit forms show a "leave blank to keep" affordance and
  // validate mssql password requirements without ever receiving the secret.
  hasDbPassword: boolean;
  hasMockTimeApiKey: boolean;
};

export type Task = InferSelectModel<typeof tasks>;
export type NewTask = InferInsertModel<typeof tasks>;

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type Invitation = InferSelectModel<typeof invitations>;
export type NewInvitation = InferInsertModel<typeof invitations>;
