// Branch rules for a project's sources. Pure: no database import.

export const DEFAULT_BRANCH = "main";

/** A component's branch when the project has no default: its build spec's first branch, else "main". */
export function fallbackBranch(
  buildSpec: { branches: string[] } | null | undefined
): string {
  return buildSpec?.branches[0] ?? DEFAULT_BRANCH;
}

/** The branch a repo picked in New environment starts on: project default, build spec's first, repo default, "main". */
export function initialRepoBranch(input: {
  projectDefault?: string | null;
  specBranches?: readonly string[] | null;
  repoDefault?: string | null;
}): string {
  return (
    input.projectDefault ||
    input.specBranches?.[0] ||
    input.repoDefault ||
    DEFAULT_BRANCH
  );
}

/** An environment chip on the Sources tab: no target, or its branch against the default (defaultBranch ?? fallbackBranch). */
export function branchChip(
  sourceBranch: string | null,
  effectiveDefault: string
): "noTarget" | "matches" | "differs" {
  if (sourceBranch === null) return "noTarget";
  return sourceBranch === effectiveDefault ? "matches" : "differs";
}
