// Pure decisions for Home's layout and header. Client-safe.

export type SectionMode = "full" | "compact" | "hidden";
export type MainSection = { id: "attention" | "issues"; mode: SectionMode };

/**
 * Role adaptation, driven by data instead of a job-role field. Attention leads
 * when there is something to fix and the user either operates environments or
 * has no issues of their own. An ops user with nothing failing sees a compact
 * "all clear"; anyone else with nothing failing doesn't see the section.
 */
export function sectionOrder(input: {
  hasOpsAccess: boolean;
  attentionCount: number;
  issueCount: number;
}): MainSection[] {
  const { hasOpsAccess, attentionCount, issueCount } = input;
  const attention: MainSection = {
    id: "attention",
    mode: attentionCount > 0 ? "full" : hasOpsAccess ? "compact" : "hidden",
  };
  const issues: MainSection = {
    id: "issues",
    mode: issueCount > 0 ? "full" : "compact",
  };
  const attentionFirst =
    attentionCount > 0 && (issueCount === 0 || hasOpsAccess);
  return attentionFirst ? [attention, issues] : [issues, attention];
}

// Four buckets so Indonesian gets pagi/siang/sore/malam; other locales may map
// two buckets to the same phrase.
export type GreetingKey = "morning" | "midday" | "afternoon" | "night";

export function greetingKey(hour: number): GreetingKey {
  if (hour >= 4 && hour < 11) return "morning";
  if (hour >= 11 && hour < 15) return "midday";
  if (hour >= 15 && hour < 18) return "afternoon";
  return "night";
}

/** The wall-clock hour (0–23) of `date` in `timeZone`. */
export function hourIn(timeZone: string, date: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone,
    }).format(date)
  );
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** Where "New issue" points by default: the last-opened writable environment. */
export function defaultIssueTarget(
  recent: { id: string; projectId: string }[],
  writableProjectIds: ReadonlySet<string>
): { projectId: string; environmentId: string } | null {
  const env = recent.find((e) => writableProjectIds.has(e.projectId));
  return env ? { projectId: env.projectId, environmentId: env.id } : null;
}
