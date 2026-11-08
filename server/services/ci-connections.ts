import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireOrgPermission } from "@/lib/authz";
import {
  type BitbucketAuth,
  verifyBitbucketAuth,
} from "@/lib/ci/forges/bitbucket";
import { type CiProvider, CiProviderError } from "@/lib/ci/types";
import {
  createWoodpeckerProvider,
  verifyWoodpeckerToken,
} from "@/lib/ci/woodpecker";
import { db } from "@/lib/db";
import {
  appComponents,
  type CiConnection,
  ciConnections,
} from "@/lib/db/schema";
import { isUniqueViolation } from "@/lib/people/names";
import { decryptSecret, encryptNullable } from "@/lib/secrets";
import { badRequest, notFound } from "@/server/errors";

/**
 * Admin management of CI servers (Woodpecker). Credentials are encrypted on
 * write and reduced to presence flags on read; nothing here returns them.
 *
 * The permission is checked by each exported admin function, not by the
 * router, so later routes on the same router can ask for a different one.
 */

export type SafeCiConnection = {
  id: string;
  name: string;
  provider: CiConnection["provider"];
  forge: CiConnection["forge"];
  baseUrl: string;
  forgeUsername: string | null;
  hasApiToken: boolean;
  hasForgeToken: boolean;
};

function toSafe(row: CiConnection): SafeCiConnection {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    forge: row.forge,
    baseUrl: row.baseUrl,
    forgeUsername: row.forgeUsername,
    hasApiToken: !!row.apiToken,
    hasForgeToken: !!row.forgeToken,
  };
}

// Empty string clears a credential, an absent key keeps it. A non-empty value
// is trimmed, and one that is only whitespace is rejected rather than cleared.
const credential = z
  .string()
  .max(2048)
  .transform((value, ctx) => {
    if (value === "") return "";
    const trimmed = value.trim();
    if (trimmed === "") ctx.addIssue({ code: "custom", message: "Blank" });
    return trimmed;
  });

export const updateCiConnectionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.url().max(2048).optional(),
  apiToken: credential.optional(),
  forgeUsername: z.string().trim().max(255).optional(),
  forgeToken: credential.optional(),
});

async function findConnection(id: string): Promise<CiConnection> {
  const [row] = await db
    .select()
    .from(ciConnections)
    .where(eq(ciConnections.id, id))
    .limit(1);
  return row ?? notFound();
}

export async function listCiConnections(): Promise<SafeCiConnection[]> {
  await requireOrgPermission({ integration: ["manage"] });
  const rows = await db
    .select()
    .from(ciConnections)
    .orderBy(ciConnections.name);
  return rows.map(toSafe);
}

export async function updateCiConnection(
  id: string,
  changes: z.infer<typeof updateCiConnectionSchema>
): Promise<SafeCiConnection> {
  await requireOrgPermission({ integration: ["manage"] });
  const patch: Partial<typeof ciConnections.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (changes.name !== undefined) patch.name = changes.name;
  if (changes.baseUrl !== undefined) {
    const baseUrl = changes.baseUrl.replace(/\/+$/, "");
    const current = await findConnection(id);
    if (baseUrl !== current.baseUrl) {
      // The stored token must not follow the connection to another host.
      if (!changes.apiToken) {
        badRequest("Enter the API token again when changing the URL");
      }
    }
    patch.baseUrl = baseUrl;
  }
  if (changes.apiToken !== undefined) {
    patch.apiToken = encryptNullable(changes.apiToken) || null;
  }
  if (changes.forgeToken !== undefined) {
    patch.forgeToken = encryptNullable(changes.forgeToken) || null;
  }
  if (changes.forgeUsername !== undefined) {
    patch.forgeUsername = changes.forgeUsername || null;
  }
  try {
    const [updated] = await db
      .update(ciConnections)
      .set(patch)
      .where(eq(ciConnections.id, id))
      .returning();
    return updated ? toSafe(updated) : notFound();
  } catch (error) {
    if (isUniqueViolation(error)) badRequest("That name is already in use");
    throw error;
  }
}

/**
 * The outcome of checking a connection's stored credentials. A failure names
 * its reason by a stable code (`ciForm.verifyCodes.*`); nothing carries a
 * credential or the provider's own error text.
 */
export type CiConnectionCheck = {
  ci: "ok" | "failed";
  ciCode: CiCheckCode | null;
  forge: "ok" | "failed" | "notConfigured";
  forgeCode: ForgeCheckCode | null;
};
type CiCheckCode =
  | "ciTokenMissing"
  | "ciTokenRejected"
  | "ciUnreachable"
  | "ciFailed";
type ForgeCheckCode =
  | "forgeCredentialsRejected"
  | "forgeUnreachable"
  | "forgeUnsupported"
  | "forgeFailed";

function failureKind(error: unknown): "rejected" | "unreachable" | "failed" {
  if (!(error instanceof CiProviderError)) return "failed";
  if (error.status === 401 || error.status === 403) return "rejected";
  // 0: no answer or a timeout; 3xx: a login page (e.g. Access) in the way.
  if (error.status === 0 || (error.status >= 300 && error.status < 400)) {
    return "unreachable";
  }
  return "failed";
}

const CI_CODES = {
  rejected: "ciTokenRejected",
  unreachable: "ciUnreachable",
  failed: "ciFailed",
} as const satisfies Record<string, CiCheckCode>;
const FORGE_CODES = {
  rejected: "forgeCredentialsRejected",
  unreachable: "forgeUnreachable",
  failed: "forgeFailed",
} as const satisfies Record<string, ForgeCheckCode>;

/**
 * Checks the stored credentials: the CI API token with the provider's
 * current-user call, and the forge credentials by reading a repository of
 * this connection (or the forge account when none is registered).
 */
export async function verifyCiConnection(
  id: string
): Promise<CiConnectionCheck> {
  await requireOrgPermission({ integration: ["manage"] });
  const row = await findConnection(id);

  let ci: Pick<CiConnectionCheck, "ci" | "ciCode">;
  if (!row.apiToken) {
    ci = { ci: "failed", ciCode: "ciTokenMissing" };
  } else {
    try {
      await verifyWoodpeckerToken(row.baseUrl, decryptSecret(row.apiToken));
      ci = { ci: "ok", ciCode: null };
    } catch (error) {
      ci = { ci: "failed", ciCode: CI_CODES[failureKind(error)] };
    }
  }

  let forge: Pick<CiConnectionCheck, "forge" | "forgeCode">;
  if (!(row.forgeUsername && row.forgeToken)) {
    forge = { forge: "notConfigured", forgeCode: null };
  } else if (row.forge !== "bitbucket") {
    forge = { forge: "failed", forgeCode: "forgeUnsupported" };
  } else {
    const [component] = await db
      .select({ repoFullName: appComponents.repoFullName })
      .from(appComponents)
      .where(eq(appComponents.ciConnectionId, id))
      .limit(1);
    try {
      await verifyBitbucketAuth(
        { username: row.forgeUsername, token: decryptSecret(row.forgeToken) },
        component?.repoFullName ?? null
      );
      forge = { forge: "ok", forgeCode: null };
    } catch (error) {
      forge = { forge: "failed", forgeCode: FORGE_CODES[failureKind(error)] };
    }
  }

  return { ...ci, ...forge };
}

function providerFor(row: CiConnection): CiProvider {
  if (!row.apiToken) {
    throw new HTTPException(409, {
      message: "This CI connection has no API token",
    });
  }
  return createWoodpeckerProvider(row.baseUrl, decryptSecret(row.apiToken));
}

/**
 * The provider client for a connection, with its token decrypted. Does not
 * check a permission: callers (routes with their own, different permissions)
 * must do that first.
 */
export async function getProviderForConnection(
  id: string
): Promise<CiProvider> {
  return providerFor(await findConnection(id));
}

/**
 * What an app registrant needs to pick a connection: no URL, no credential.
 * Does not check a permission (see getProviderForConnection).
 */
export async function listConnectionOptions(): Promise<
  {
    id: string;
    name: string;
    forge: CiConnection["forge"];
    hasForgeToken: boolean;
  }[]
> {
  const rows = await db
    .select()
    .from(ciConnections)
    .orderBy(ciConnections.name);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    forge: row.forge,
    hasForgeToken: !!(row.forgeUsername && row.forgeToken),
  }));
}

/**
 * The forge and the decrypted forge credentials (null when either part is
 * missing) for committing files. Does not check a permission (see
 * getProviderForConnection); the token must never leave the server.
 */
export async function getForgeCredentials(
  id: string
): Promise<{ forge: CiConnection["forge"]; auth: BitbucketAuth | null }> {
  const row = await findConnection(id);
  return {
    forge: row.forge,
    auth:
      row.forgeUsername && row.forgeToken
        ? { username: row.forgeUsername, token: decryptSecret(row.forgeToken) }
        : null,
  };
}
