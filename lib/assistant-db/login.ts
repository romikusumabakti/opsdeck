import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { environmentServices } from "@/lib/db/schema";
import { decryptNullable } from "@/lib/secrets";
import type { DatabaseType } from "@/lib/services";

/** The dedicated read-only login the Assistant queries an environment's database with. */
export type AssistantDbLogin = {
  engine: DatabaseType;
  serviceId: string;
  login: string;
  // mssql and mysql only (decrypted); postgres uses trusted local auth.
  password?: string;
  database: string;
};

/**
 * The environment's read-only login, or null when an admin/infra hasn't
 * enabled it (or it can't be used: an external database, or an mssql/mysql
 * login without its password). Server-only; the password must never reach a
 * response, a job payload, the activity log or a log line.
 */
export async function getAssistantDbLogin(
  environmentId: string
): Promise<AssistantDbLogin | null> {
  const [row] = await db
    .select({
      id: environmentServices.id,
      dbType: environmentServices.dbType,
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
        isNotNull(environmentServices.assistantDbLogin),
        or(
          isNull(environmentServices.dbKind),
          ne(environmentServices.dbKind, "external")
        )
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
  if (row.dbType === "postgres") return base;
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
