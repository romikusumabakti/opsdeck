import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
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
export const issueStatusEnum = pgEnum("issue_status", [
  "open",
  "in_progress",
  "resolved",
  "closed",
]);
// Why an environment exists — lets the grid/switcher label the 1..N deployments
// of a project by purpose (a QA's own copy, a frontend dev's, a devops sandbox)
// instead of an opaque host suffix.
export const environmentKindEnum = pgEnum("environment_kind", [
  "qa",
  "dev",
  "release",
  "sandbox",
  "prod",
]);

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
  // Root the SFTP file explorer is confined to (see lib/explorer/confineSftpPath).
  // Defaults to "/" (whole host as the SSH user). Narrow it per server — e.g.
  // "/home/deploy" or "/var/www" — to limit the blast radius of the explorer.
  sftpRoot: text("sftp_root").notNull().default("/"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// The real, logical project — one application (e.g. "Common Membership",
// "TMLI Portal"), independent of how many times it is deployed. An issue
// tracker, knowledge, and members hang off THIS, not off a deployment. Each
// project owns one or more `environments` (the concrete server/db/backend/
// frontend triples that used to each be a top-level "project" row).
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),
  // Short stable identifier used as the issue-key prefix (e.g. "CMEM" -> CMEM-42)
  // and in URLs. Uppercase, unique across all projects.
  key: text("key").notNull().unique(),
  // Optional grouping label for the owning client/tenant (e.g. "DPLK", "TMLI").
  // A plain nullable column, not a table — promote to `clients` only if per-client
  // access control is ever needed. Keeps the model two-level, not three.
  client: text("client"),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// A concrete deployment of a project — the server/db/backend/frontend triple a
// QA, a frontend dev, or devops runs. This is what used to be a top-level
// "project" row; runs (backups/restores/mock-time) act on ONE environment.
export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
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

    // --- Purpose / ownership (both optional) ---
    // What this deployment is for; drives the kind badge in the grid/switcher.
    kind: environmentKindEnum("kind"),
    // Who owns this deployment (e.g. "QA — Budi", "FE dev"). Free text: owners
    // aren't always app users, and this is a human label, not an access grant.
    owner: text("owner"),
  },
  (t) => [
    // Every project page lists its environments; index the parent FK.
    index("environments_project_idx").on(t.projectId),
    // Environment names are unique within a project (so "Dev"/"Release"/"QA-Budi"
    // can't collide under one project, while different projects may reuse them).
    uniqueIndex("environments_project_name_idx").on(t.projectId, t.name),
    // FK columns are filtered/joined on every server-usage lookup and the
    // onDelete:restrict checks; index them so those don't seq-scan.
    index("environments_db_server_idx").on(t.dbServerId),
    index("environments_backend_server_idx").on(t.backendServerId),
    index("environments_frontend_server_idx").on(t.frontendServerId),
  ]
);

export const runStatusEnum = pgEnum("run_status", [
  "started",
  "success",
  "failed",
]);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // A run acts on ONE deployment, so this references `environments`. The
    // column keeps its `project_id` name for continuity with the route param
    // `[projectId]` and job payloads — historically a "project" was a deployment.
    projectId: uuid("project_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    // Nullable + set null on user delete: preserve audit history even after the
    // initiating user is removed. UI shows "Unknown" when null.
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    description: text("description").notNull(),
    status: runStatusEnum("status").notNull().default("started"),
    // Streaming log appended by worker job steps via appendRunOutput. Lines are
    // separated by `\n`; the SSE endpoint emits the full snapshot on each tick.
    output: text("output").notNull().default(""),
    errorMessage: text("error_message"),
    runAt: timestamp("run_at").notNull(),
    // Null while still running. Set once status transitions to success/failed.
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    // Every run query filters by projectId and orders by runAt desc
    // (getProjectRuns, getProjectKpis, findLatestByKind, DISTINCT ON).
    index("runs_project_run_idx").on(t.projectId, t.runAt.desc()),
    // getActiveRuns filters status='started'.
    index("runs_status_idx").on(t.status),
  ]
);

// Per-user, per-environment recency. Drives the header switcher's order:
// most-recently-opened first (MRU). One row per (user, environment); upserted on
// each open by recordProjectAccess. Column keeps its `project_id` name for
// continuity — the thing opened is a deployment (`environments`).
export const projectAccess = pgTable(
  "project_access",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    lastAccessedAt: timestamp("last_accessed_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.projectId] }),
    // getProjects orders one user's rows by lastAccessedAt desc; a covering
    // index on (userId, lastAccessedAt) serves that without a sort.
    index("project_access_user_recency_idx").on(
      t.userId,
      t.lastAccessedAt.desc()
    ),
  ]
);

// =========================
// Issue tracker (per project)
// =========================

// Issues belong to the LOGICAL project, not a deployment, so a bug tracked as
// CMEM-42 is stable no matter which environment it was seen in. `number` is a
// per-project sequential counter (assigned as max(number)+1 within a
// transaction in the create action) that pairs with projects.key to form the
// human key. `environmentId` optionally pins which deployment it was found in.
export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Per-project sequential number -> `${project.key}-${number}` (e.g. CMEM-42).
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: issueStatusEnum("status").notNull().default("open"),
    // Which deployment the issue was observed in. set null: the issue outlives
    // any single environment. Null = not tied to a specific one.
    environmentId: uuid("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    assigneeId: uuid("assignee_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // The human issue key CMEM-42 must resolve to exactly one row.
    uniqueIndex("issues_project_number_idx").on(t.projectId, t.number),
    // Board/list view filters by project then status.
    index("issues_project_status_idx").on(t.projectId, t.status),
  ]
);

// Threaded discussion on an issue. Author is set null on user delete so the
// comment survives (shown as "Unknown"); the row is deleted with its issue.
export const issueComments = pgTable(
  "issue_comments",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // The detail page lists a thread oldest-first.
    index("issue_comments_issue_idx").on(t.issueId, t.createdAt),
  ]
);

// Workspace-wide issue labels (shared across all projects so the global issue
// view can filter by one taxonomy). `color` is a hex string rendered as a chip.
export const labels = pgTable("labels", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("#64748b"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Many-to-many join between issues and labels.
export const issueLabels = pgTable(
  "issue_labels",
  {
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.labelId] }),
    // "Which issues have label X" for the label filter.
    index("issue_labels_label_idx").on(t.labelId),
  ]
);

// =========================
// Notifications
// =========================

export const notificationTypeEnum = pgEnum("notification_type", [
  "issue_assigned",
  "run_failed",
]);

// Per-user inbox items. Text is NOT stored — only a `type` + structured `data`
// so the message renders in the recipient's own locale at read time (their
// locale isn't known when the event fires). `href` is the jump target.
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationTypeEnum("type").notNull(),
    // Params for the i18n template keyed by `type` (e.g. { key, number, title }).
    data: jsonb("data").$type<Record<string, string | number>>().notNull(),
    href: text("href"),
    // Null = unread. Set when the user opens/acknowledges it.
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // The bell lists one user's notifications newest-first and counts unread.
    index("notifications_user_created_idx").on(t.userId, t.createdAt.desc()),
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
// Custom: S3 storage connections
// =========================

// User-configured S3-compatible endpoints browsed by the storage explorer.
// Distinct from the single env-configured bucket in lib/storage.ts (KB
// attachments): those creds are ops-owned infra config, these are arbitrary
// targets an admin points the explorer at (Garage, real S3, SeaweedFS, Ceph…).
// Managing them is admin-only; `secretKey` never crosses the server/client
// boundary (see SafeS3Connection).
export const s3Connections = pgTable("s3_connections", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),
  endpoint: text("endpoint").notNull(),
  region: text("region").notNull().default("us-east-1"),
  bucket: text("bucket").notNull(),
  accessKeyId: text("access_key_id").notNull(),
  // Secret credential. Stored like servers.password (plaintext today; see the
  // at-rest encryption TODO in docs) and stripped before reaching the client.
  secretKey: text("secret_key").notNull(),
  // Path-style addressing (bucket in the URL path, not a virtual-host DNS
  // prefix). Required by Garage and most self-hosted S3; real AWS S3 tolerates
  // it too, so it defaults on.
  forcePathStyle: boolean("force_path_style").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

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
// via /api/knowledge/asset/<id>. The markdown body is the single source of truth
// for which asset a document references (same as backlinks), so there is no
// document_id FK to keep in sync. No automatic GC yet: unreferenced uploads
// accumulate slowly — when it matters, prune out-of-band by extracting the asset
// ids from every document body (mirror extractLinkedSlugs) and deleting rows no
// body references, rather than maintaining a mutable FK.
export const knowledgeAttachments = pgTable("knowledge_attachments", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  // Object key in the bucket, e.g. "kb/<uuid>.webp". Server-generated; never
  // user input, so no path-traversal surface.
  storageKey: text("storage_key").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedById: uuid("uploaded_by_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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

// The logical project (parent). Deployment-level data lives on `Environment`.
export type Project = InferSelectModel<typeof projects>;
export type NewProject = InferInsertModel<typeof projects>;

export type Issue = InferSelectModel<typeof issues>;
export type NewIssue = InferInsertModel<typeof issues>;

export type Notification = InferSelectModel<typeof notifications>;
export type NewNotification = InferInsertModel<typeof notifications>;

export type IssueComment = InferSelectModel<typeof issueComments>;
export type NewIssueComment = InferInsertModel<typeof issueComments>;

export type Label = InferSelectModel<typeof labels>;
export type NewLabel = InferInsertModel<typeof labels>;
// The lightweight label shape attached to issues in list/detail payloads.
export type LabelLite = Pick<Label, "id" | "name" | "color">;

// A concrete deployment. Was historically called "Project" — now `Environment`.
export type Environment = InferSelectModel<typeof environments>;
export type NewEnvironment = InferInsertModel<typeof environments>;

export type EnvironmentWithServers = Environment & {
  dbServer: Server;
  backendServer: Server;
  frontendServer: Server;
};

// Credential-free projections handed to the client. SSH passwords, the mssql
// `sa` password, and the mock-time API key must never cross the server/client
// boundary (RSC payloads are visible in the browser). Server code loads the
// full `EnvironmentWithServers` via lib/projects#loadEnvironmentWithServers; anything
// passed to a client component must be sanitized to these shapes first.
export type SafeServer = Omit<Server, "password">;

export type SafeEnvironmentWithServers = Omit<
  Environment,
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

export type Run = InferSelectModel<typeof runs>;
export type NewRun = InferInsertModel<typeof runs>;

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type Invitation = InferSelectModel<typeof invitations>;
export type NewInvitation = InferInsertModel<typeof invitations>;

export type S3Connection = InferSelectModel<typeof s3Connections>;
export type NewS3Connection = InferInsertModel<typeof s3Connections>;

// Credential-free projection handed to the client. `secretKey` must never cross
// the server/client boundary (RSC payloads are visible in the browser). Server
// code loads the full row; anything passed to a client component is sanitized
// to this shape first. `hasSecret` lets edit forms show a "leave blank to keep"
// affordance without ever receiving the secret.
export type SafeS3Connection = Omit<S3Connection, "secretKey"> & {
  hasSecret: boolean;
};
