import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type AppComponent,
  appComponents,
  ciConnections,
} from "@/lib/db/schema";

/**
 * Lookups for the configuration extension (server/routes/ci-config.ts). No
 * permission check: the caller is Woodpecker, authenticated by its signature.
 */

/** The connection's cached extension key, or null when the connection is unknown. */
export async function findExtensionKey(
  connectionId: string
): Promise<{ publicKeyPem: string | null } | null> {
  const [row] = await db
    .select({ publicKeyPem: ciConnections.extensionPublicKey })
    .from(ciConnections)
    .where(eq(ciConnections.id, connectionId))
    .limit(1);
  return row ?? null;
}

/** The component the CI server builds as `ciRepoId` on this connection, if any. */
export async function findComponentByCiRepo(
  connectionId: string,
  ciRepoId: string
): Promise<Pick<
  AppComponent,
  "componentKey" | "pipelineMode" | "buildSpec"
> | null> {
  const [row] = await db
    .select({
      componentKey: appComponents.componentKey,
      pipelineMode: appComponents.pipelineMode,
      buildSpec: appComponents.buildSpec,
    })
    .from(appComponents)
    .where(
      and(
        eq(appComponents.ciConnectionId, connectionId),
        eq(appComponents.ciRepoId, ciRepoId)
      )
    )
    .limit(1);
  return row ?? null;
}
