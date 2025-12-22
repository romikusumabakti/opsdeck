import { InferInsertModel, InferSelectModel } from "drizzle-orm";
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

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),

  // --- Database ---
  dbServerHost: text("db_server_host").notNull(),
  dbServerUsername: text("db_server_username").notNull(),
  dbServerPassword: text("db_server_password").notNull(),
  dbServiceType: serviceTypeEnum("db_service_type").notNull(),
  dbServiceName: text("db_service_name").notNull(),
  dbType: databaseTypeEnum("db_type").notNull(),
  dbName: text("db_name").notNull(),
  dbIsBackupMounted: boolean("db_is_backup_mounted").notNull(),
  dbBackupPath: text("db_backup_path").notNull(),

  // --- Backend ---
  backendServerHost: text("backend_server_host").notNull(),
  backendServerUsername: text("backend_server_username").notNull(),
  backendServerPassword: text("backend_server_password").notNull(),
  backendServiceType: serviceTypeEnum("backend_service_type").notNull(),
  backendServiceName: text("backend_service_name").notNull(),

  // --- Frontend ---
  frontendServerHost: text("frontend_server_host").notNull(),
  frontendServerUsername: text("frontend_server_username").notNull(),
  frontendServerPassword: text("frontend_server_password").notNull(),
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

export type Project = InferSelectModel<typeof projects>;
export type NewProject = InferInsertModel<typeof projects>;

export type Task = InferSelectModel<typeof tasks>;
export type NewTask = InferInsertModel<typeof tasks>;
