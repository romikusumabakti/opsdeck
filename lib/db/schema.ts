import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const serviceTypeEnum = pgEnum("service_type", ["docker", "system"]);
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

export const projects = pgTable("projects", {
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
  // Path inside the container where backup files live. All operations run via
  // `docker exec`, so this is the only path the panel needs to know about —
  // bind-mount configuration is the operator's concern.
  dbBackupPath: text("db_backup_path").notNull(),

  // --- Backend ---
  backendServerId: uuid("backend_server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "restrict" }),
  backendServiceType: serviceTypeEnum("backend_service_type").notNull(),
  backendServiceName: text("backend_service_name").notNull(),
  // If set, the simulate-time feature will POST to this URL instead of
  // falling back to the legacy `date -s` + restart approach. The endpoint
  // is expected to accept JSON body `{ simulatedAt: <ISO string> }`.
  backendSimulateTimeApiUrl: text("backend_simulate_time_api_url"),

  // --- Frontend ---
  frontendServerId: uuid("frontend_server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "restrict" }),
  frontendServiceType: serviceTypeEnum("frontend_service_type").notNull(),
  frontendServiceName: text("frontend_service_name").notNull(),
});

export const taskStatusEnum = pgEnum("task_status", [
  "started",
  "success",
  "failed",
]);

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  // Nullable + set null on user delete: preserve audit history even after the
  // initiating user is removed. UI shows "Unknown" when null.
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  description: text("description").notNull(),
  status: taskStatusEnum("status").notNull().default("started"),
  // Streaming log appended by Inngest steps via appendTaskOutput. Lines are
  // separated by `\n`; the SSE endpoint emits the full snapshot on each tick.
  output: text("output").notNull().default(""),
  errorMessage: text("error_message"),
  runAt: timestamp("run_at").notNull(),
  // Null while still running. Set once status transitions to success/failed.
  completedAt: timestamp("completed_at"),
});

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

export const sessions = pgTable("sessions", {
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
});

export const accounts = pgTable("accounts", {
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
});

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

export const invitations = pgTable("invitations", {
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
});

export type Server = InferSelectModel<typeof servers>;
export type NewServer = InferInsertModel<typeof servers>;

export type Project = InferSelectModel<typeof projects>;
export type NewProject = InferInsertModel<typeof projects>;

export type ProjectWithServers = Project & {
  dbServer: Server;
  backendServer: Server;
  frontendServer: Server;
};

export type Task = InferSelectModel<typeof tasks>;
export type NewTask = InferInsertModel<typeof tasks>;

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type Invitation = InferSelectModel<typeof invitations>;
export type NewInvitation = InferInsertModel<typeof invitations>;
