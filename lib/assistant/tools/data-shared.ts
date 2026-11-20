import type { EnvironmentListItem } from "@/lib/db/schema";
import { redactSecretLines } from "../secret-filter";
import type { AssistantViewer, ProjectEntry } from "../viewer";
import type { ToolMeta, ToolResult } from "./code";
import { capBytes } from "./context";
import type { DataTurn } from "./data";

/** Helpers shared by the data tools (data.ts) and the issue tools. */

const MAX_SHORT_TEXT = 200;

export function fail(error: string, meta: ToolMeta = {}): ToolResult<never> {
  return { ok: false, error, meta };
}

export function ok<T>(data: T, meta: ToolMeta = {}): ToolResult<T> {
  return { ok: true, data, meta };
}

/** Drops null, undefined and empty-array fields. */
export function compact<T extends Record<string, unknown>>(
  value: T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) =>
        v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)
    )
  ) as Partial<T>;
}

export function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function clamp(
  value: number | null | undefined,
  fallback: number,
  max: number
) {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : fallback;
  return Math.min(Math.max(1, n), max);
}

/** Free text through the secret filter, cut to `maxBytes`. */
export function safeText(
  text: string | null | undefined,
  maxBytes = MAX_SHORT_TEXT
): { text: string | null; redacted: number } {
  if (!text) return { text: null, redacted: 0 };
  const redacted = redactSecretLines(text);
  const cut = capBytes(redacted.text, maxBytes);
  return {
    text: cut.truncated ? `${cut.text}…` : cut.text,
    redacted: redacted.redacted,
  };
}

export function withWithheld(meta: ToolMeta, withheld: number): ToolMeta {
  return withheld > 0 ? { ...meta, withheld } : meta;
}

export type DataContext = {
  viewer: AssistantViewer;
  data: DataTurn;
  mode: "auto" | "pinned";
};

/** The same refusal as the code tools: an invisible project is unknown. */
export function unknownProjectError(
  key: string,
  mode: "auto" | "pinned"
): string {
  return mode === "auto"
    ? `Unknown project ${key}. Call list_projects.`
    : `Unknown project ${key}. Call list_environments.`;
}

export const unknownEnvironment = (ref: string) =>
  `Unknown environment ${ref}. Call list_environments.`;

export async function projectByKey(
  ctx: DataContext,
  given: string
): Promise<ProjectEntry | string> {
  // Keys are stored uppercase; the model may echo one loosely.
  const key = given.trim().toUpperCase();
  const project = (await ctx.data.projects()).find((p) => p.key === key);
  return project ?? key;
}

export const envRef = (env: EnvironmentListItem) => `${env.key}/${env.slug}`;

export async function environmentByRef(
  ctx: DataContext,
  given: string
): Promise<EnvironmentListItem | null> {
  const needle = given.trim();
  const envs = await ctx.data.environments();
  const byId = envs.find((e) => e.id === needle);
  if (byId) return byId;
  const slash = needle.indexOf("/");
  if (slash < 0) return null;
  const key = needle.slice(0, slash).trim().toUpperCase();
  const slug = needle
    .slice(slash + 1)
    .trim()
    .toLowerCase();
  const current = envs.find((e) => e.key === key && e.slug === slug);
  if (current) return current;
  // An old slug (renamed since), e.g. from an earlier turn of the chat; only
  // ever one of the environments the viewer sees.
  const projectId = envs.find((e) => e.key === key)?.projectId;
  const resolved = projectId
    ? await ctx.data.cores.resolveEnvironmentSlug(projectId, slug)
    : null;
  return envs.find((e) => e.id === resolved?.environment.id) ?? null;
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Whether `query` names the person: a substring of their name, what they like
 * to be called, email or title, ignoring case and accents. An empty query
 * matches everyone.
 */
export function personMatchesQuery(
  person: {
    name: string;
    preferredName: string | null;
    email: string;
    title: string | null;
  },
  query: string
): boolean {
  const needle = fold(query.trim());
  if (!needle) return true;
  return [person.name, person.preferredName, person.email, person.title].some(
    (field) => field !== null && fold(field).includes(needle)
  );
}
