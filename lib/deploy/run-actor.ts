/** Who a run's "By" cell shows. */
export type RunActor =
  | { kind: "user"; name: string }
  | { kind: "autoUser"; name: string }
  | { kind: "auto"; by: string | null }
  | { kind: "unknown" };

/**
 * A Panel user always wins. Otherwise a run with an actor (`triggeredBy`: a
 * forge login or a commit author email) is an auto-deploy — by the Panel user
 * that actor resolves to (`autoUserName`, matched by email) or else by the raw
 * actor. `auto` marks a run known to be automatic even without an actor (a
 * deployment with trigger `auto`).
 */
export function runActorLabel(run: {
  userName?: string | null;
  autoUserName?: string | null;
  triggeredBy?: string | null;
  auto?: boolean;
}): RunActor {
  if (run.userName) return { kind: "user", name: run.userName };
  if (run.triggeredBy && run.autoUserName) {
    return { kind: "autoUser", name: run.autoUserName };
  }
  if (run.triggeredBy) return { kind: "auto", by: run.triggeredBy };
  if (run.auto) return { kind: "auto", by: null };
  return { kind: "unknown" };
}

/**
 * The actor an auto run of a build carries (runs.triggered_by): the forge
 * login that pushed it, else its head commit's author email (lower-cased) —
 * Bitbucket Cloud sends no login. Null when neither is known.
 */
export function autoRunActor(build: {
  pushedBy: string | null;
  commitAuthorEmail: string | null;
}): string | null {
  const login = build.pushedBy?.trim();
  if (login) return login;
  const email = build.commitAuthorEmail?.trim().toLowerCase();
  return email ? email : null;
}

/** The first line of a commit message, for table cells. */
export function firstLine(message: string | null): string | null {
  const line = message?.split(/\r?\n/, 1)[0]?.trim();
  return line ? line : null;
}

/**
 * The description prefix of a deploy's pre-deploy backup run; the backfill
 * finds those runs by it.
 */
export const PRE_DEPLOY_BACKUP_PREFIX = "Pre-deploy backup for ";

/**
 * The description of a deploy's pre-deploy backup run. Its "<component> <tag>"
 * matches the deploy run's (see deploymentRunDescription).
 */
export function preDeployBackupDescription(
  componentKey: string,
  tag: string
): string {
  return `${PRE_DEPLOY_BACKUP_PREFIX}${componentKey} ${tag}`;
}
