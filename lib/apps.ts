import { and, eq, getTableColumns, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type DbExecutor, db } from "@/lib/db";
import {
  type App,
  type AppComponent,
  appComponents,
  apps,
  environments,
} from "@/lib/db/schema";
import { COMPONENT_OTHER_APP_MESSAGE } from "@/lib/deploy/errors";

/** A component as listed to clients: everything but the notify secret. */
export type PublicAppComponent = Omit<AppComponent, "notifySecret">;

const { notifySecret: _notifySecret, ...publicComponentColumns } =
  getTableColumns(appComponents);

/**
 * The component and its app, or undefined when the key is unknown.
 * `notifySecret` is still encrypted (see lib/secrets.ts).
 */
export async function getComponent(
  componentKey: string
): Promise<(AppComponent & { app: App }) | undefined> {
  const [row] = await db
    .select({ component: appComponents, app: apps })
    .from(appComponents)
    .innerJoin(apps, eq(apps.id, appComponents.appId))
    .where(eq(appComponents.componentKey, componentKey));
  return row && { ...row.component, app: row.app };
}

export async function listApps(): Promise<
  (App & { components: PublicAppComponent[] })[]
> {
  const rows = await db
    .select({ app: apps, component: publicComponentColumns })
    .from(apps)
    .leftJoin(appComponents, eq(appComponents.appId, apps.id))
    .orderBy(apps.appKey, appComponents.componentKey);
  const byId = new Map<string, App & { components: PublicAppComponent[] }>();
  for (const { app, component } of rows) {
    const entry = byId.get(app.id) ?? { ...app, components: [] };
    if (component) entry.components.push(component);
    byId.set(app.id, entry);
  }
  return [...byId.values()];
}

/**
 * An environment deploys one app: a target's component must belong to it. An
 * environment with no app yet (managed without deploy, or new) adopts the
 * component's app; the conditional UPDATE keeps two concurrent first targets
 * from setting different apps. Pass the transaction that inserts the target so
 * a failed insert leaves `app_id` unchanged.
 */
export async function assertTargetMatchesEnvironmentApp(
  environmentId: string,
  componentKey: string,
  executor: DbExecutor = db
): Promise<void> {
  const [component] = await executor
    .select({ appId: appComponents.appId })
    .from(appComponents)
    .where(eq(appComponents.componentKey, componentKey));
  if (!component) {
    throw new HTTPException(404, { message: "Component not found" });
  }
  const adopted = await executor
    .update(environments)
    .set({ appId: component.appId })
    .where(and(eq(environments.id, environmentId), isNull(environments.appId)))
    .returning({ id: environments.id });
  if (adopted.length > 0) return;
  const [environment] = await executor
    .select({ appId: environments.appId })
    .from(environments)
    .where(eq(environments.id, environmentId));
  if (!environment) {
    throw new HTTPException(404, { message: "Environment not found" });
  }
  if (environment.appId !== component.appId) {
    throw new HTTPException(409, { message: COMPONENT_OTHER_APP_MESSAGE });
  }
}
