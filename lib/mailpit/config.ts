import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { environmentMailpit } from "@/lib/db/schema";
import { decryptNullable } from "@/lib/secrets";
import type { MailpitConfig } from "./client";

// SINGLE decryption boundary for Mailpit credentials, mirroring
// lib/environments#loadEnvironmentWithServers. The result carries a plaintext
// password: server-side callers only, never returned to a client component.
export async function loadMailpitConfig(
  environmentId: string
): Promise<MailpitConfig | null> {
  const [row] = await db
    .select()
    .from(environmentMailpit)
    .where(eq(environmentMailpit.environmentId, environmentId))
    .limit(1);
  if (!row) return null;
  return {
    url: row.url,
    username: row.username,
    password: decryptNullable(row.password),
  };
}

// "Test connection" with a blank password field should test the stored one —
// but only against the stored URL. Otherwise an admin could point the URL at
// a host they control and receive the stored password in the Basic header.
export function shouldReuseStoredPassword(
  input: { url: string; username: string | null; password?: string },
  stored: MailpitConfig | null
): boolean {
  return Boolean(
    stored?.password &&
      input.username &&
      !input.password &&
      input.url === stored.url
  );
}
