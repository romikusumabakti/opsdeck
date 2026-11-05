/** Who a run's "By" cell shows. */
export type RunActor =
  | { kind: "user"; name: string }
  | { kind: "auto"; by: string | null }
  | { kind: "unknown" };

/**
 * A Panel user always wins; otherwise a run with a forge login is an auto-deploy
 * by that login. `auto` marks a run known to be automatic even without a login
 * (a deployment with trigger `auto`).
 */
export function runActorLabel(run: {
  userName?: string | null;
  triggeredBy?: string | null;
  auto?: boolean;
}): RunActor {
  if (run.userName) return { kind: "user", name: run.userName };
  if (run.triggeredBy) return { kind: "auto", by: run.triggeredBy };
  if (run.auto) return { kind: "auto", by: null };
  return { kind: "unknown" };
}

/** The first line of a commit message, for table cells. */
export function firstLine(message: string | null): string | null {
  const line = message?.split(/\r?\n/, 1)[0]?.trim();
  return line ? line : null;
}
