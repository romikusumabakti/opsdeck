import type { z } from "zod";
import { resolveLink } from "@/lib/jira/sync";
import { zonedDayStart } from "@/lib/timezone";
import type { IssueQuery } from "@/server/services/issues";
import type { ToolMeta, ToolResult } from "./code";
import { listIssueAttachments, visibleIssueByKey } from "./context";
import type { DATA_INPUTS } from "./data";
import {
  clamp,
  compact,
  type DataContext,
  environmentByRef,
  fail,
  iso,
  ok,
  personMatchesQuery,
  projectByKey,
  safeText,
  unknownEnvironment,
  unknownProjectError,
  withWithheld,
} from "./data-shared";

/**
 * Issue tools: list_issues (the Issues page's filters) and get_issue (one
 * issue by its Menara or Jira key). Both read through the viewer's scope.
 */

export const ISSUE_LIST_LIMIT = 50;
export const DEFAULT_ISSUE_LIST_LIMIT = 20;
export const MAX_ISSUE_DESCRIPTION_BYTES = 16 * 1024;
export const MAX_ISSUE_COMMENTS = 50;
export const MAX_ISSUE_COMMENT_BYTES = 4 * 1024;
/** People or candidates named in an ambiguity message. */
const MAX_CANDIDATES = 5;

export type ListIssuesInput = z.infer<typeof DATA_INPUTS.list_issues>;

export type IssueRow = {
  key: string;
  jiraKey?: string;
  title: string | null;
  status: string;
  type: string;
  priority: string;
  assignee?: string;
  environment?: string;
  createdAt: string | null;
  updatedAt: string | null;
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const BAD_DATE = "Use YYYY-MM-DD or an ISO datetime with an offset.";

/**
 * A date argument as an instant. A bare day is that day in `timeZone`: its
 * start for a lower bound, the next day's start for an (exclusive) upper
 * bound. A datetime with `Z` or an offset is that instant. Anything else is
 * null.
 */
export function resolveDateBound(
  raw: string,
  edge: "from" | "to",
  timeZone: string
): Date | null {
  const text = raw.trim();
  const day = DATE_ONLY.exec(text);
  if (day) {
    const [, year, month, date] = day.map(Number);
    const check = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1));
    // Rejects 2026-02-31, which Date.UTC would roll into March.
    if (check.getUTCMonth() !== (month ?? 1) - 1) return null;
    if (edge === "from") return zonedDayStart(text, timeZone);
    check.setUTCDate(check.getUTCDate() + 1);
    return zonedDayStart(check.toISOString().slice(0, 10), timeZone);
  }
  if (DATE_TIME.test(text)) {
    const at = new Date(text);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  return null;
}

type Resolved<T> = { value: T } | { error: string };

async function resolvePerson(
  ctx: DataContext,
  raw: string,
  allowed: { me: boolean }
): Promise<Resolved<string>> {
  const query = raw.trim();
  if (allowed.me && query.toLowerCase() === "me") {
    return { value: ctx.viewer.userId };
  }
  const people = await ctx.data.cores.listPeople(ctx.viewer.scope);
  const byId = people.find((p) => p.id === query);
  if (byId) return { value: byId.id };
  const matches = people.filter((p) => personMatchesQuery(p, query));
  const [only, ...rest] = matches;
  if (!only) return { error: `No person matches "${query}".` };
  if (rest.length === 0) return { value: only.id };
  const names = matches
    .slice(0, MAX_CANDIDATES)
    .map((p) => `${p.name} <${p.email}>`)
    .join(", ");
  const more = matches.length > MAX_CANDIDATES ? ", …" : "";
  return {
    error: `Several people match "${query}": ${names}${more}. Use the email or the full name.`,
  };
}

async function resolveLabels(
  ctx: DataContext,
  names: string[]
): Promise<Resolved<string[]>> {
  const all = await ctx.data.cores.listLabels();
  const ids: string[] = [];
  for (const name of names) {
    const wanted = name.trim().toLowerCase();
    const found = all.find((l) => l.name.toLowerCase() === wanted);
    if (!found) return { error: `No label named "${name.trim()}".` };
    ids.push(found.id);
  }
  return { value: ids };
}

async function resolveMilestone(
  ctx: DataContext,
  raw: string,
  projectId: string | undefined
): Promise<Resolved<string>> {
  const projects = await ctx.data.projects();
  const scoped = projectId
    ? projects.filter((p) => p.id === projectId)
    : projects;
  const wanted = raw.trim().toLowerCase();
  const found = (
    await ctx.data.cores.listMilestones(scoped.map((p) => p.id))
  ).filter((m) => m.name.toLowerCase() === wanted);
  const [only, ...rest] = found;
  if (!only) return { error: `No milestone named "${raw.trim()}".` };
  if (rest.length === 0) return { value: only.id };
  const keyOf = new Map(projects.map((p) => [p.id, p.key] as const));
  const candidates = found
    .slice(0, MAX_CANDIDATES)
    .map((m) => `${keyOf.get(m.projectId) ?? "?"}: ${m.name}`)
    .join(", ");
  return {
    error: `Several milestones are named "${raw.trim()}" (${candidates}). Pass project to pick one.`,
  };
}

const SORTS = {
  updated: "updatedAt",
  created: "createdAt",
  priority: "priority",
} as const;

export async function listIssuesTool(
  ctx: DataContext,
  input: ListIssuesInput
): Promise<ToolResult<{ total: number; issues: IssueRow[] }>> {
  const query: IssueQuery = {
    status: "all",
    sort: SORTS[input.sort ?? "updated"],
    desc: input.order !== "asc",
    limit: clamp(input.limit, DEFAULT_ISSUE_LIST_LIMIT, ISSUE_LIST_LIMIT),
  };
  let meta: ToolMeta = {};

  const text = input.query?.trim();
  if (text) query.q = text;
  if (input.project) {
    const found = await projectByKey(ctx, input.project);
    if (typeof found === "string") {
      return fail(unknownProjectError(found, ctx.mode), { project: found });
    }
    query.projectId = found.id;
    meta = { project: found.key };
  }
  if (input.status?.length) query.statuses = input.status;
  if (input.type?.length) query.types = input.type;
  if (input.priority?.length) query.priorities = input.priority;

  const assignee = input.assignee?.trim();
  if (assignee?.toLowerCase() === "unassigned") {
    query.unassigned = true;
  } else if (assignee) {
    const person = await resolvePerson(ctx, assignee, { me: true });
    if ("error" in person) return fail(person.error, meta);
    query.assigneeId = person.value;
  }
  const reporter = input.reporter?.trim();
  if (reporter) {
    const person = await resolvePerson(ctx, reporter, { me: true });
    if ("error" in person) return fail(person.error, meta);
    query.createdById = person.value;
  }
  if (input.labels?.length) {
    const labels = await resolveLabels(ctx, input.labels);
    if ("error" in labels) return fail(labels.error, meta);
    query.labelIds = labels.value;
  }
  if (input.environment) {
    const environment = await environmentByRef(ctx, input.environment);
    if (!environment) {
      return fail(unknownEnvironment(input.environment.trim()), meta);
    }
    query.environmentId = environment.id;
  }
  if (input.milestone?.trim()) {
    const milestone = await resolveMilestone(
      ctx,
      input.milestone,
      query.projectId
    );
    if ("error" in milestone) return fail(milestone.error, meta);
    query.milestoneId = milestone.value;
  }

  const bounds = [
    ["created_from", "from", "createdFrom"],
    ["created_to", "to", "createdTo"],
    ["updated_from", "from", "updatedFrom"],
    ["updated_to", "to", "updatedTo"],
  ] as const;
  for (const [field, edge, target] of bounds) {
    const raw = input[field];
    if (!raw?.trim()) continue;
    const at = resolveDateBound(raw, edge, ctx.data.timeZone);
    if (!at) return fail(BAD_DATE, meta);
    query[target] = at;
  }
  if (input.offset && input.offset > 0) {
    query.offset = Math.trunc(input.offset);
  }

  const page = await ctx.data.cores.listIssues(ctx.viewer.scope, query);
  let withheld = 0;
  const issues = page.rows.slice(0, ISSUE_LIST_LIMIT).map((i): IssueRow => {
    const title = safeText(i.title);
    withheld += title.redacted;
    return compact({
      key: `${i.project.key}-${i.number}`,
      jiraKey: i.jiraKey,
      title: title.text,
      status: i.status,
      type: i.type,
      priority: i.priority,
      assignee: i.assignee?.name ?? null,
      environment: i.environment?.name ?? null,
      createdAt: iso(i.createdAt),
      updatedAt: iso(i.updatedAt),
    }) as IssueRow;
  });
  return ok(
    { total: page.total, issues },
    withWithheld({ ...meta, issueKeys: issues.map((i) => i.key) }, withheld)
  );
}

const MENARA_KEY = /^([A-Z][A-Z0-9_]*)-([1-9][0-9]{0,8})$/;

type IssueDetail = NonNullable<
  Awaited<ReturnType<DataContext["data"]["cores"]["getIssueDetail"]>>
>;

export type IssueDetailData = Record<string, unknown>;

/** The issue as the model reads it: text filtered and capped. */
function detailData(
  issue: IssueDetail,
  withheld: { count: number }
): IssueDetailData {
  const projectKey = issue.project.key;
  const text = (value: string | null | undefined, maxBytes?: number) => {
    const safe = safeText(value, maxBytes);
    withheld.count += safe.redacted;
    return safe.text;
  };
  const ref = (r: { number: number; title: string; status: string }) =>
    compact({
      key: `${projectKey}-${r.number}`,
      title: text(r.title),
      status: r.status,
    });
  const comments = issue.comments.slice(-MAX_ISSUE_COMMENTS).map((c) =>
    compact({
      author: c.author?.name ?? null,
      at: iso(c.createdAt),
      body: text(c.body, MAX_ISSUE_COMMENT_BYTES),
    })
  );
  return compact({
    key: `${projectKey}-${issue.number}`,
    jiraKey: issue.jiraKey,
    project: projectKey,
    title: text(issue.title),
    status: issue.status,
    type: issue.type,
    priority: issue.priority,
    estimate: issue.estimate,
    environment: issue.environment?.name ?? null,
    assignee: issue.assignee?.name ?? null,
    createdBy: issue.createdBy?.name ?? null,
    createdAt: iso(issue.createdAt),
    updatedAt: iso(issue.updatedAt),
    labels: issue.labels.map((l) => l.name),
    parent: issue.parent ? ref(issue.parent) : null,
    children: issue.children.map(ref),
    description: text(issue.description, MAX_ISSUE_DESCRIPTION_BYTES),
    comments,
    olderComments:
      issue.comments.length > comments.length
        ? issue.comments.length - comments.length
        : null,
  });
}

/**
 * One issue by Menara key ("ACME-12") or Jira key. With no `source` the
 * Menara key wins, then a visible issue mirrored from that Jira key; when
 * both exist as different issues the Menara one is returned and the other
 * is named in `otherMatch`.
 */
export async function getIssueTool(
  ctx: DataContext,
  rawKey: string,
  source: "menara" | "jira" | null
): Promise<ToolResult<IssueDetailData>> {
  const given = rawKey.trim();
  const key = given.toUpperCase();
  const notFound = fail(`Issue ${given} not found.`);
  const { cores } = ctx.data;

  const byMenara = async () => {
    const match = MENARA_KEY.exec(key);
    if (!match?.[1] || !match[2]) return null;
    return cores.getIssueDetail(ctx.viewer.scope, match[1], Number(match[2]));
  };
  const menara = source === "jira" ? null : await byMenara();
  const jira =
    source === "menara" ? null : await visibleIssueByKey(ctx.viewer, key);

  let issue = menara;
  let otherMatch: string | null = null;
  let visible = jira && menara && jira.issue.id === menara.id ? jira : null;
  if (!issue && jira) {
    const project = (await ctx.data.projects()).find(
      (p) => p.id === jira.issue.projectId
    );
    if (!project) return notFound;
    issue = await cores.getIssueDetail(
      ctx.viewer.scope,
      project.key,
      jira.issue.number
    );
    visible = jira;
  } else if (issue && jira && jira.issue.id !== issue.id) {
    const project = (await ctx.data.projects()).find(
      (p) => p.id === jira.issue.projectId
    );
    otherMatch = `Jira issue ${jira.issue.jiraKey ?? key} is Menara issue ${project?.key ?? "?"}-${jira.issue.number}; call get_issue with source "jira" to read it.`;
  }
  if (!issue) return notFound;

  const withheld = { count: 0 };
  const data = detailData(issue, withheld);
  if (otherMatch) data.otherMatch = otherMatch;
  if (issue.jiraKey) {
    // The attachment list is read live from Jira, through the project's link.
    const mirrored = visible ?? {
      issue,
      link: await resolveLink(issue.projectId),
    };
    const { attachments, error } = await listIssueAttachments(mirrored);
    data.attachments = attachments;
    if (error) data.attachmentsError = error;
  }
  return ok(
    data,
    withWithheld(
      { project: issue.project.key, issueKeys: [String(data.key)] },
      withheld.count
    )
  );
}
