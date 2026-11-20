import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { environmentServices } from "@/lib/db/schema";
import { decryptNullable } from "@/lib/secrets";
import type { DatabaseType } from "@/lib/services";

/** The dedicated read-only login the Assistant queries an environment's database with. */
export type AssistantDbLogin = {
  engine: DatabaseType;
  serviceId: string;
  login: string;
  // Decrypted. mssql, mysql and Postgres on systemd (which logs in over
  // 127.0.0.1); container and shared Postgres use trusted local auth, none.
  password?: string;
  database: string;
};

/**
 * The environment's read-only login, or null when an admin/infra hasn't
 * enabled it (or it can't be used: a login that needs a password, mssql,
 * mysql or systemd Postgres, without one it can decrypt). Server-only; the password must never reach a
 * response, a job payload, the activity log or a log line.
 */
export async function getAssistantDbLogin(
  environmentId: string
): Promise<AssistantDbLogin | null> {
  const [row] = await db
    .select({
      id: environmentServices.id,
      dbType: environmentServices.dbType,
      serviceType: environmentServices.serviceType,
      dbName: environmentServices.dbName,
      login: environmentServices.assistantDbLogin,
      password: environmentServices.assistantDbPassword,
    })
    .from(environmentServices)
    .where(
      and(
        eq(environmentServices.environmentId, environmentId),
        eq(environmentServices.role, "db"),
        eq(environmentServices.assistantDbEnabled, true),
        isNotNull(environmentServices.assistantDbLogin)
      )
    )
    .limit(1);
  if (!(row?.dbType && row.dbName && row.login)) return null;
  const base = {
    engine: row.dbType,
    serviceId: row.id,
    login: row.login,
    database: row.dbName,
  };
  if (row.dbType === "postgres" && row.serviceType !== "systemd") return base;
  let password: string | null;
  try {
    password = decryptNullable(row.password);
  } catch {
    console.error(
      `Assistant database login of environment ${environmentId} could not be decrypted`
    );
    return null;
  }
  return password ? { ...base, password } : null;
}

/**
 * Turns the environment's access off (committed at once, so the Assistant
 * stops) and returns the login still recorded on the db service, if any.
 */
export async function turnOffAssistantDbAccess(
  serviceId: string
): Promise<string | null> {
  const [row] = await db
    .update(environmentServices)
    .set({ assistantDbEnabled: false })
    .where(eq(environmentServices.id, serviceId))
    .returning({ login: environmentServices.assistantDbLogin });
  return row?.login ?? null;
}

/** Forgets a login once it is dropped (only while it is still the recorded one). */
export async function forgetAssistantDbLogin(
  serviceId: string,
  login: string
): Promise<void> {
  await db
    .update(environmentServices)
    .set({
      assistantDbEnabled: false,
      assistantDbLogin: null,
      assistantDbPassword: null,
      assistantDbEnabledAt: null,
      assistantDbEnabledBy: null,
    })
    .where(
      and(
        eq(environmentServices.id, serviceId),
        eq(environmentServices.assistantDbLogin, login)
      )
    );
}
