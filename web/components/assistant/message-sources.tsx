import { ChevronRight } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { AssistantSource } from "@/lib/assistant/sources";
import { DATE_TIME } from "@/lib/format-date";
import type { ConversationMessage } from "@/web/api/assistant";

type ToolCall = ConversationMessage["toolCalls"][number];

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

/**
 * The data tools listed under "Panel data". The Menara issue tools are left
 * out: their keys are listed under Issues.
 */
export const DATA_READ_TOOLS: ReadonlySet<string> = new Set([
  "list_environments",
  "get_environment_status",
  "list_deploys",
  "get_deploy",
  "get_service_logs",
  "list_builds",
  "list_people",
  "list_servers",
  "get_server",
  "recent_activity",
  "list_tables",
  "query_database",
]);

/** The message key of a tool's label (`assistant.toolLabels.<tool>`). */
export const toolLabelKey = (tool: string): string => `toolLabels.${tool}`;

/**
 * What an answer read, from its tool calls' result metadata: files (a read
 * range where there is one, else the path a search hit), Jira issues,
 * knowledge documents, the data tools (each tool once per environment or
 * project it read) and how many files the secret filter withheld. A read of
 * an automatic answer names its project (`KEY path`): paths are relative to
 * the project, so two projects may share one.
 */
export function summarizeReads(toolCalls: ToolCall[]) {
  const ranges = new Set<string>();
  const paths = new Set<string>();
  const issueKeys = new Set<string>();
  const docSlugs = new Set<string>();
  const panel = new Map<string, { tool: string; subject: string | null }>();
  let withheld = 0;
  for (const { tool, meta } of toolCalls) {
    if (DATA_READ_TOOLS.has(tool)) {
      const subject =
        typeof meta.environment === "string"
          ? meta.environment
          : typeof meta.project === "string"
            ? meta.project
            : null;
      panel.set(`${tool} ${subject ?? ""}`, { tool, subject });
      if (typeof meta.withheld === "number") withheld += meta.withheld;
      continue;
    }
    const prefix = typeof meta.project === "string" ? `${meta.project} ` : "";
    for (const r of strings(meta.ranges)) ranges.add(prefix + r);
    for (const p of strings(meta.paths)) paths.add(prefix + p);
    for (const k of strings(meta.issueKeys)) issueKeys.add(k);
    for (const s of strings(meta.docSlugs)) docSlugs.add(s);
    if (typeof meta.withheld === "number") withheld += meta.withheld;
  }
  const rangePaths = new Set(
    [...ranges].map((r) => r.slice(0, r.lastIndexOf(":")))
  );
  const files = [
    ...ranges,
    ...[...paths].filter((p) => !rangePaths.has(p)),
  ].sort();
  return {
    files,
    issueKeys: [...issueKeys].sort(),
    docSlugs: [...docSlugs].sort(),
    panel: [...panel.values()],
    withheld,
  };
}

function SourceLine({
  source,
  projectBranches,
}: {
  source: AssistantSource;
  projectBranches: boolean;
}) {
  const t = useTranslations("assistant");
  const format = useFormatter();
  const at = source.commitSha
    ? source.commitSha.slice(0, 7)
    : source.ref || source.componentKey;
  // A project-branch answer reads each branch head: nothing was deployed, so
  // there is nothing to warn about.
  const neutral = projectBranches || (source.deployed && !!source.commitSha);
  const state = projectBranches
    ? t("sourceBranchHead", { ref: source.ref })
    : !source.deployed
      ? t("sourceNotDeployed", { ref: source.ref })
      : source.commitSha
        ? t("sourceDeployedAt", {
            at: source.deployedAt
              ? format.dateTime(new Date(source.deployedAt), DATE_TIME)
              : "—",
          })
        : t("sourceUnknownCommit", { ref: source.ref });
  return (
    <li className="flex flex-col">
      <span className="font-mono text-xs">
        {source.projectKey ? `${source.projectKey} · ` : ""}
        {source.repoFullName} @ {at}
      </span>
      <span
        className={
          neutral
            ? "text-muted-foreground"
            : "text-amber-600 dark:text-amber-500"
        }
      >
        {state}
      </span>
    </li>
  );
}

function ReadList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item} className="font-mono text-xs break-all">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The collapsible "Sources" of one assistant answer. `projectBranches`: its
 * question asked about the project branches, not an environment.
 */
export function MessageSources({
  sources,
  toolCalls,
  projectBranches = false,
}: {
  sources: AssistantSource[] | null;
  toolCalls: ToolCall[];
  projectBranches?: boolean;
}) {
  const t = useTranslations("assistant");
  const reads = summarizeReads(toolCalls);
  const components = sources ?? [];
  if (
    components.length === 0 &&
    reads.files.length === 0 &&
    reads.issueKeys.length === 0 &&
    reads.docSlugs.length === 0 &&
    reads.panel.length === 0 &&
    reads.withheld === 0
  ) {
    return null;
  }
  return (
    <Collapsible className="text-sm">
      <CollapsibleTrigger className="group flex w-fit items-center gap-1 rounded-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRight className="size-4 transition-transform group-data-[panel-open]:rotate-90" />
        {t("sources")}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-3 rounded-lg border p-3">
        {components.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="font-medium">{t("sourceCode")}</span>
            <ul className="flex flex-col gap-1.5">
              {components.map((source) => (
                <SourceLine
                  key={`${source.componentKey}:${source.repoFullName}`}
                  source={source}
                  projectBranches={projectBranches}
                />
              ))}
            </ul>
          </div>
        )}
        <ReadList label={t("filesRead")} items={reads.files} />
        <ReadList label={t("issuesRead")} items={reads.issueKeys} />
        <ReadList label={t("docsRead")} items={reads.docSlugs} />
        <ReadList
          label={t("panelRead")}
          items={reads.panel.map(({ tool, subject }) =>
            subject
              ? `${t(toolLabelKey(tool))} · ${subject}`
              : t(toolLabelKey(tool))
          )}
        />
        {reads.withheld > 0 && (
          <p className="text-muted-foreground">
            {t("withheld", { count: reads.withheld })}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
