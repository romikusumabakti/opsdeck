import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const serviceTypeEnum = pgEnum("service_type", ["docker", "system"]);
export const databaseTypeEnum = pgEnum("database_type", ["postgres", "mssql"]);

export const servers = pgTable("servers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  username: text("username").notNull(),
  password: text("password").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),

  // --- Database ---
  dbServerId: integer("db_server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "restrict" }),
  dbServiceType: serviceTypeEnum("db_service_type").notNull(),
  dbServiceName: text("db_service_name").notNull(),
  dbType: databaseTypeEnum("db_type").notNull(),
  dbName: text("db_name").notNull(),
  dbIsBackupMounted: boolean("db_is_backup_mounted").notNull(),
  dbBackupPath: text("db_backup_path").notNull(),

  // --- Backend ---
  backendServerId: integer("backend_server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "restrict" }),
  backendServiceType: serviceTypeEnum("backend_service_type").notNull(),
  backendServiceName: text("backend_service_name").notNull(),

  // --- Frontend ---
  frontendServerId: integer("frontend_server_id")
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
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  description: text("description").notNull(),
  runAt: timestamp("run_at").notNull(),
  completedAt: timestamp("completed_at").notNull(),
});

// =========================
// Auth (better-auth) tables
// =========================

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
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
  id: text("id").primaryKey(),
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
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  token: text("token").notNull().unique(),
  invitedById: text("invited_by_id").references(() => users.id, {
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
