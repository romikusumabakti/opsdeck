import { createPublicKey } from "node:crypto";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireOrgPermission } from "@/lib/authz";
import { type CiProvider, CiProviderError } from "@/lib/ci/types";
import { createWoodpeckerProvider } from "@/lib/ci/woodpecker";
import { db } from "@/lib/db";
import { type CiConnection, ciConnections } from "@/lib/db/schema";
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
  hasExtensionKey: boolean;
  extensionPublicKeyFetchedAt: Date | null;
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
    hasExtensionKey: !!row.extensionPublicKey,
    extensionPublicKeyFetchedAt: row.extensionPublicKeyFetchedAt,
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
      // The cached signing key belongs to the old server.
      patch.extensionPublicKey = null;
      patch.extensionPublicKeyFetchedAt = null;
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

function isEd25519PublicKey(pem: string): boolean {
  try {
    return createPublicKey(pem).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/** Fetches the CI server's extension signing key and stores it. */
export async function refreshExtensionKey(
  id: string
): Promise<SafeCiConnection> {
  await requireOrgPermission({ integration: ["manage"] });
  const provider = providerFor(await findConnection(id));
  let key: string;
  try {
    key = await provider.fetchExtensionPublicKey();
  } catch (error) {
    if (error instanceof CiProviderError) {
      throw new HTTPException(502, { message: error.message });
    }
    throw error;
  }
  if (!isEd25519PublicKey(key)) {
    throw new HTTPException(502, {
      message: "Woodpecker did not return a valid ed25519 public key",
    });
  }
  const [updated] = await db
    .update(ciConnections)
    .set({
      extensionPublicKey: key,
      extensionPublicKeyFetchedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(ciConnections.id, id))
    .returning();
  return updated ? toSafe(updated) : notFound();
}
