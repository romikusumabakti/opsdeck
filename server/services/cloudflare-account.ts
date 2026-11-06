import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { requireOrgPermission } from "@/lib/authz";
import {
  CloudflareApiError,
  type CloudflareCreds,
  listAccessPolicies,
  listIdentityProviders,
  listTunnels,
  verifyAccount,
} from "@/lib/cloudflare/api";
import { db } from "@/lib/db";
import { type CloudflareAccount, cloudflareAccounts } from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { badRequest } from "@/server/errors";

/**
 * The Cloudflare account the Panel manages tunnels, Access apps and DNS
 * records in. The token is write-only: stored encrypted, reduced to a
 * `hasToken` flag on read, and never returned.
 *
 * Every exported admin function checks org server:manage itself.
 */

export type SafeCloudflareAccount = Omit<CloudflareAccount, "apiToken"> & {
  hasToken: boolean;
};

function toSafe(row: CloudflareAccount): SafeCloudflareAccount {
  const { apiToken, ...rest } = row;
  return { ...rest, hasToken: !!apiToken };
}

// A blank token keeps the stored one; a non-blank one is trimmed.
export const cloudflareAccountInputSchema = z.object({
  accountId: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{32}$/, "Invalid account id"),
  name: z.string().trim().min(1).max(120),
  apiToken: z.string().trim().max(2048).optional(),
  accessIdpId: z.string().trim().max(255).nullable().optional(),
});

async function findAccount(): Promise<CloudflareAccount | null> {
  const [row] = await db.select().from(cloudflareAccounts).limit(1);
  return row ?? null;
}

export async function getCloudflareAccount(): Promise<SafeCloudflareAccount | null> {
  await requireOrgPermission({ server: ["manage"] });
  const row = await findAccount();
  return row ? toSafe(row) : null;
}

export async function saveCloudflareAccount(
  input: z.infer<typeof cloudflareAccountInputSchema>
): Promise<SafeCloudflareAccount> {
  const session = await requireOrgPermission({ server: ["manage"] });
  const current = await findAccount();
  const newToken = input.apiToken || undefined;

  let saved: CloudflareAccount | undefined;
  if (!current) {
    if (!newToken) badRequest("Enter the API token");
    [saved] = await db
      .insert(cloudflareAccounts)
      .values({
        accountId: input.accountId,
        name: input.name,
        apiToken: encryptSecret(newToken),
        accessIdpId: input.accessIdpId || null,
      })
      .returning();
  } else {
    // The stored token must not follow the record to another account.
    if (input.accountId !== current.accountId && !newToken) {
      badRequest("Enter the API token again when changing the account id");
    }
    const patch: Partial<typeof cloudflareAccounts.$inferInsert> = {
      accountId: input.accountId,
      name: input.name,
      updatedAt: new Date(),
    };
    if (newToken) patch.apiToken = encryptSecret(newToken);
    if (input.accessIdpId !== undefined) {
      patch.accessIdpId = input.accessIdpId || null;
    }
    [saved] = await db
      .update(cloudflareAccounts)
      .set(patch)
      .where(eq(cloudflareAccounts.id, current.id))
      .returning();
  }
  if (!saved) throw new Error("Cloudflare account was not saved");

  // Field names only: neither the token nor any other value is logged.
  const fields = ["accountId", "name", "accessIdpId"];
  if (newToken) fields.push("apiToken");
  await recordActivity({
    actorId: session.user.id,
    action: "cloudflare_account.update",
    entityType: "cloudflare_account",
    entityId: saved.id,
    data: { fields: fields.join(", ") },
  });
  return toSafe(saved);
}

/**
 * The account's id and decrypted token for API calls. Does not check a
 * permission: callers must do that first, and the token must never leave the
 * server.
 */
export async function getCloudflareCreds(): Promise<CloudflareCreds> {
  const row = await findAccount();
  if (!row) {
    throw new HTTPException(409, {
      message: "The Cloudflare account is not set up",
    });
  }
  return { accountId: row.accountId, apiToken: decryptSecret(row.apiToken) };
}

// Cloudflare's own error text (already free of headers and the token) is the
// useful part of a failed call, so it is passed on as a bad gateway.
async function withCloudflare<T>(
  call: (creds: CloudflareCreds) => Promise<T>
): Promise<T> {
  await requireOrgPermission({ server: ["manage"] });
  const creds = await getCloudflareCreds();
  try {
    return await call(creds);
  } catch (error) {
    if (error instanceof CloudflareApiError) {
      throw new HTTPException(502, { message: error.message });
    }
    throw error;
  }
}

export const verifyCloudflareAccount = () => withCloudflare(verifyAccount);
export const listCloudflareTunnels = () => withCloudflare(listTunnels);
export const listCloudflareAccessPolicies = () =>
  withCloudflare(listAccessPolicies);
export const listCloudflareIdentityProviders = () =>
  withCloudflare(listIdentityProviders);
