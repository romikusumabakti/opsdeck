import { and, eq } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { assistantDbUnavailableReason } from "@/lib/assistant-db/availability";
import {
  AssistantDbLoginRefused,
  disableAssistantDbLogin,
  enableAssistantDbLogin,
} from "@/lib/assistant-db/provision";
import { requireOrgGrant, requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import type { ServiceWithServer } from "@/lib/db/schema";
import { environmentServices } from "@/lib/db/schema";
import {
  environmentName,
  loadEnvironmentWithServers,
} from "@/lib/environments";
import { encryptNullable } from "@/lib/secrets";
import { findService } from "@/lib/services";
import { tearingDownIn } from "@/lib/teardown/guard";
import { CodedHTTPException } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";
import { teardownRunningError } from "@/server/services/teardown-runs";

// The Assistant's read-only database login per environment (Stage 9 spec
// F.1/F.2): off by default; only admin and infra (org server:manage, on top
// of editing the environment) turn it on or off. Enabling provisions the
// dedicated login through the Panel's admin path (lib/assistant-db/provision)
// before the row says enabled; disabling turns the row off first, so the
// Assistant stops at once, then drops the login. The login's password never
// leaves the server: not in the response, the activity, or a log line.

/** What the settings tab gets back: never a password. */
export type AssistantDbAccess = {
  enabled: boolean;
  login: string | null;
  enabledAt: string | null;
};

const ACTION = "environment.assistantDbAccess";

async function refuse(
  status: 409 | 502,
  code: string,
  params?: Record<string, string>
): Promise<never> {
  const t = await getServerTranslator("actionErrors");
  throw new CodedHTTPException(status, code, t(code, params), params);
}

function view(row: {
  assistantDbEnabled: boolean;
  assistantDbLogin: string | null;
  assistantDbEnabledAt: Date | null;
}): AssistantDbAccess {
  return {
    enabled: row.assistantDbEnabled,
    login: row.assistantDbLogin,
    enabledAt: row.assistantDbEnabledAt?.toISOString() ?? null,
  };
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Turns the Assistant's read-only database access for an environment on or
 * off. 403 below admin/infra; 409 without a database service or for a
 * database the Panel can't administer (external, incomplete, no admin
 * password); 502 when the database server refused (the message carries its
 * redacted reason). Enabling again refreshes the grants and keeps the
 * stored password; disabling an environment that is already off is a no-op.
 */
export async function setAssistantDbAccess(
  environmentId: string,
  enabled: boolean
): Promise<AssistantDbAccess> {
  const { session } = await requireProjectPermission(
    { environmentId },
    { environment: ["update"] }
  );
  requireOrgGrant(session, { server: ["manage"] });
  const environment = await loadEnvironmentWithServers(environmentId);
  const stored = environment ? findService(environment, "db") : undefined;
  if (!stored) return refuse(409, "assistantDbNoDatabase");
  const name = (await environmentName(environmentId)) ?? "";
  return enabled
    ? enable(environmentId, stored, session.user.id, name)
    : disable(environmentId, stored, session.user.id, name);
}

const serviceRow = (id: string) => eq(environmentServices.id, id);

async function enable(
  environmentId: string,
  stored: ServiceWithServer,
  actorId: string,
  name: string
): Promise<AssistantDbAccess> {
  const reason = assistantDbUnavailableReason({
    dbKind: stored.dbKind,
    serviceType: stored.serviceType,
    dbType: stored.dbType,
    dbName: stored.dbName,
    hasAdminPassword: Boolean(stored.dbPassword),
  });
  if (reason) return refuse(409, "assistantDbUnavailable", { reason });
  // The row lock serializes toggles of one environment for the whole run.
  // The environment's shared lock, held until commit, keeps a teardown start
  // or a panel-only delete (both exclusive) from passing a login being made;
  // under it, a teardown already under way refuses before any SSH.
  const result = await db.transaction(async (tx) => {
    if (await tearingDownIn(tx, environmentId)) {
      return { ok: false as const, tearingDown: true as const };
    }
    const [locked] = await tx
      .select({
        enabled: environmentServices.assistantDbEnabled,
        login: environmentServices.assistantDbLogin,
      })
      .from(environmentServices)
      .where(serviceRow(stored.id))
      .for("update");
    if (!locked) return null;
    let provisioned: { login: string; password: string | null };
    try {
      provisioned = await enableAssistantDbLogin(stored, {
        environmentId,
        // Only the recorded login is refreshed (keeping its password); any
        // other of that name on the server is refused.
        ownLogin: locked.login,
        password: stored.assistantDbPassword,
      });
    } catch (error) {
      if (error instanceof AssistantDbLoginRefused) {
        return { ok: false as const, refused: error };
      }
      return { ok: false as const, error: messageOf(error) };
    }
    const [row] = await tx
      .update(environmentServices)
      .set({
        assistantDbEnabled: true,
        assistantDbLogin: provisioned.login,
        assistantDbPassword: encryptNullable(provisioned.password),
        ...(locked.enabled
          ? {}
          : {
              assistantDbEnabledAt: new Date(),
              assistantDbEnabledBy: actorId,
            }),
      })
      .where(serviceRow(stored.id))
      .returning();
    return row ? { ok: true as const, row, wasEnabled: locked.enabled } : null;
  });
  if (!result) return refuse(409, "assistantDbNoDatabase");
  if (!result.ok) {
    if ("tearingDown" in result) throw teardownRunningError();
    if (result.refused) {
      return refuse(
        409,
        result.refused.reason === "exists"
          ? "assistantDbLoginExists"
          : "assistantDbLoginMappedElsewhere",
        { login: result.refused.login }
      );
    }
    console.error(
      `Assistant database login for environment ${environmentId} failed: ${result.error}`
    );
    return refuse(502, "assistantDbProvisionFailed", {
      reason: result.error ?? "",
    });
  }
  if (!result.wasEnabled) {
    await recordActivity({
      actorId,
      action: ACTION,
      entityType: "environment",
      entityId: environmentId,
      data: { environment: name, enabled: "true" },
    });
  }
  return view(result.row);
}

async function disable(
  environmentId: string,
  stored: ServiceWithServer,
  actorId: string,
  name: string
): Promise<AssistantDbAccess> {
  // Off first and committed: the Assistant stops querying at once, even if
  // the database server can't be reached to drop the login.
  const [off] = await db
    .update(environmentServices)
    .set({ assistantDbEnabled: false })
    .where(
      and(
        serviceRow(stored.id),
        eq(environmentServices.assistantDbEnabled, true)
      )
    )
    .returning({ id: environmentServices.id });
  if (off) {
    await recordActivity({
      actorId,
      action: ACTION,
      entityType: "environment",
      entityId: environmentId,
      data: { environment: name, enabled: "false" },
    });
  }
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        enabled: environmentServices.assistantDbEnabled,
        login: environmentServices.assistantDbLogin,
      })
      .from(environmentServices)
      .where(serviceRow(stored.id))
      .for("update");
    if (!locked) return null;
    if (locked.login) {
      try {
        await disableAssistantDbLogin(stored, {
          environmentId,
          login: locked.login,
        });
      } catch (error) {
        return {
          ok: false as const,
          error: messageOf(error),
          login: locked.login,
        };
      }
    }
    const [row] = await tx
      .update(environmentServices)
      .set({
        assistantDbEnabled: false,
        assistantDbLogin: null,
        assistantDbPassword: null,
        assistantDbEnabledAt: null,
        assistantDbEnabledBy: null,
      })
      .where(serviceRow(stored.id))
      .returning();
    return row ? { ok: true as const, row } : null;
  });
  if (!result) return refuse(409, "assistantDbNoDatabase");
  if (!result.ok) {
    console.error(
      `Dropping the Assistant database login of environment ${environmentId} failed: ${result.error}`
    );
    return refuse(502, "assistantDbDropFailed", {
      login: result.login,
      reason: result.error,
    });
  }
  return view(result.row);
}
