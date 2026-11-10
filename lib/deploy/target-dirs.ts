import type { DeployTargetKind } from "@/lib/db/schema";
import { dirWithin, normaliseDeployDir } from "@/lib/teardown/paths";

// A static deploy swaps its whole web root (the root moves to
// `<root>.opsdeck-prev`), so nothing else may live in it.

export type TargetDir = { kind: DeployTargetKind; deployDir: string };

/** Why a target's dir may not sit where it is, among the machine's targets. */
export type StaticRootConflict =
  | "staticRootContainsTarget"
  | "targetInsideStaticRoot";

/**
 * The conflict of a target's dir with the other targets on the same machine
 * (any environment): a static root that is or contains another target's dir,
 * or a dir that is or lies inside another target's static root. Null when
 * there is none. Pass the other targets only (not the target's own row).
 */
export function staticRootConflict(
  target: TargetDir,
  others: readonly TargetDir[]
): StaticRootConflict | null {
  const dir = normaliseDeployDir(target.deployDir);
  for (const other of others) {
    const otherDir = normaliseDeployDir(other.deployDir);
    if (target.kind === "static" && dirWithin(otherDir, dir)) {
      return "staticRootContainsTarget";
    }
    if (other.kind === "static" && dirWithin(dir, otherDir)) {
      return "targetInsideStaticRoot";
    }
  }
  return null;
}
