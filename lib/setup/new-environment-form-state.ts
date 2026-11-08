import {
  type NewEnvironmentInput,
  newEnvironmentInputSchema,
} from "@/lib/setup/new-environment";
import type { SetupIssue } from "@/lib/setup/schema";

// The New environment page's bookkeeping, kept pure: which part of the
// input an issue is about, what each part was when the last check ran, and
// which issues the page shows (web/routes/$locale/_app/-components/setup/
// new-environment-form.tsx).

/** The parts of the input an issue can be about (what the user touches). */
export type FormGroup =
  | "startFrom"
  | "name"
  | "repos"
  | "database"
  | "address"
  | "server"
  | "advanced";

/** Each part of an input, serialised, to tell which issues are out of date. */
export type FormSnapshot = Record<FormGroup, string>;

const GROUPS: readonly FormGroup[] = [
  "startFrom",
  "name",
  "repos",
  "database",
  "address",
  "server",
  "advanced",
];

export function groupOf(field: string): FormGroup {
  if (field === "name") return "name";
  if (field === "copyFromEnvironmentId") return "startFrom";
  if (field === "repos" || field.startsWith("repos.") || field === "targets") {
    return "repos";
  }
  if (field === "serverId" || field.startsWith("server")) return "server";
  if (field.startsWith("database") || field === "needsDatabase") {
    return "database";
  }
  if (field.startsWith("domain") || field.startsWith("address")) {
    return "address";
  }
  return "advanced";
}

const REPO_CODES = new Set([
  "repoNotFound",
  "repoUnreadable",
  "ciUnavailable",
  "repoOtherApp",
  "repoNotBuildable",
  "duplicate",
  "appKeyTaken",
  "componentKeyTaken",
  "repoLinked",
  "registrationRace",
  "pipelineFileExists",
  "targetMissing",
]);

/**
 * The field a refusal's code points at (a refusal names no field); one
 * about no field of the page is listed under General.
 */
export function fieldOfCode(code: string): string {
  if (code === "nameTaken" || code === "environmentNameTaken") return "name";
  if (code === "domainTaken" || code === "domainHostnameTaken") {
    return "domain.label";
  }
  if (code === "noServerAvailable") return "serverId";
  return REPO_CODES.has(code) ? "repos" : "general";
}

export function snapshotOf(input: NewEnvironmentInput): FormSnapshot {
  const { database, domain, ...rest } = input.advanced ?? {};
  return {
    startFrom: input.copyFromEnvironmentId ?? "",
    name: input.name,
    repos: JSON.stringify(input.repos),
    database: JSON.stringify([input.needsDatabase, database ?? null]),
    address: JSON.stringify([input.address, domain ?? null]),
    server: input.serverId ?? "",
    advanced: JSON.stringify(rest),
  };
}

/**
 * Whether a part changed since the check of `checked` ran (always, without
 * a check or a valid input). An Advanced issue may hang on any part.
 */
export function changedSince(
  snapshot: FormSnapshot | null,
  checked: FormSnapshot | null,
  group: FormGroup
): boolean {
  if (!(snapshot && checked)) return true;
  if (group === "advanced")
    return GROUPS.some((g) => snapshot[g] !== checked[g]);
  return snapshot[group] !== checked[group];
}

export function dedupe(issues: readonly SetupIssue[]): SetupIssue[] {
  return issues.filter(
    (issue, i, all) =>
      all.findIndex((x) => x.field === issue.field && x.code === issue.code) ===
      i
  );
}

/** Zod's verdict on the input, as issues at the fields the page shows. */
export function parseNewEnvironmentInput(
  raw: unknown
):
  | { ok: true; input: NewEnvironmentInput }
  | { ok: false; issues: SetupIssue[] } {
  const parsed = newEnvironmentInputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, input: parsed.data };
  return {
    ok: false,
    issues: dedupe(
      parsed.error.issues.map((issue) => ({
        field: issue.path
          .map(String)
          .join(".")
          .replace(/^advanced\./, "")
          .replace(/^address\.label$/, "domain.label"),
        code: "invalid",
      }))
    ),
  };
}

/**
 * The issues the page shows: the browser's own, and the last check's for
 * the parts unchanged since it ran; each only once its part was touched or
 * after Create. `noServerAvailable` always shows: nothing on the page fixes
 * it.
 */
export function visibleIssues({
  clientIssues,
  checkIssues,
  snapshot,
  checked,
  submitted,
  touched,
  noServerKnown,
}: {
  clientIssues: readonly SetupIssue[];
  checkIssues: readonly SetupIssue[];
  snapshot: FormSnapshot | null;
  /** The snapshot the check's issues are about. */
  checked: FormSnapshot | null;
  submitted: boolean;
  touched: ReadonlySet<FormGroup>;
  /** The page knows without a check that no server can be used. */
  noServerKnown: boolean;
}): SetupIssue[] {
  const shown = (issue: SetupIssue, fromCheck: boolean) => {
    if (issue.code === "noServerAvailable") return true;
    const group = groupOf(issue.field);
    if (!(submitted || touched.has(group))) return false;
    return !fromCheck || !changedSince(snapshot, checked, group);
  };
  return dedupe([
    ...(noServerKnown
      ? [{ field: "serverId", code: "noServerAvailable" }]
      : []),
    ...clientIssues.filter((issue) => shown(issue, false)),
    ...checkIssues.filter((issue) => shown(issue, true)),
  ]);
}
