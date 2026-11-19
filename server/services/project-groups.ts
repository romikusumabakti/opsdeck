import { and, asc, desc, eq, gt, lt, ne, sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { recordActivity } from "@/lib/activity";
import {
  projectScope,
  requireOrgPermission,
  requireProjectUser,
} from "@/lib/authz";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import { type ProjectGroup, projectGroups, projects } from "@/lib/db/schema";
import { pgErrorCode } from "@/lib/domains/errors";
import {
  projectGroupInputSchema,
  projectGroupMergeSchema,
  projectGroupReorderSchema,
  uuidSchema,
} from "@/lib/validation";
import { badRequest, CodedHTTPException } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

// Project groups: an organisational label for projects (a client, a team),
// one per project or none. They grant nothing. Any caller who works with
// projects lists them; managing them takes the org project:create statement
// (admin, lib/permissions#canManageProjectGroups). Names are unique ignoring
// case and surrounding spaces; ranks are fractional indexes, C-collated.

export type ProjectGroupSummary = Pick<ProjectGroup, "id" | "name" | "rank"> & {
  projectCount: number;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type GroupRefusal =
  | "groupNameTaken"
  | "groupNotFound"
  | "groupMergeSelf"
  | "groupReorderInvalid";

const STATUS: Record<GroupRefusal, ContentfulStatusCode> = {
  groupNameTaken: 409,
  groupNotFound: 404,
  groupMergeSelf: 400,
  groupReorderInvalid: 400,
};

async function refuse(code: GroupRefusal): Promise<never> {
  const t = await getServerTranslator("actionErrors");
  throw new CodedHTTPException(STATUS[code], code, t(code));
}

/** The right to manage groups: the org statement that creates projects. */
async function requireManageGroups() {
  return requireOrgPermission({ project: ["create"] });
}

function parsed<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) badRequest("Invalid request");
  return result.data;
}

// Ids come from the client; a non-uuid is a missing group, not a SQL error.
async function groupId(id: string): Promise<string> {
  if (!uuidSchema.safeParse(id).success) await refuse("groupNotFound");
  return id;
}

// Creating and reordering read neighbouring ranks and write one between them;
// one at a time, so two of them never compute the same rank.
async function lockRanks(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('project_groups.rank', 0))`
  );
}

async function nameTaken(
  tx: Tx,
  name: string,
  exceptId?: string
): Promise<boolean> {
  const [row] = await tx
    .select({ id: projectGroups.id })
    .from(projectGroups)
    .where(
      and(
        sql`lower(trim(${projectGroups.name})) = lower(trim(${name}))`,
        exceptId ? ne(projectGroups.id, exceptId) : undefined
      )
    )
    .limit(1);
  return row !== undefined;
}

// The unique index catches a name taken by a concurrent write after the check.
async function uniqueName<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (pgErrorCode(error) === "23505") await refuse("groupNameTaken");
    throw error;
  }
}

async function lockGroup(tx: Tx, id: string): Promise<ProjectGroup> {
  const [row] = await tx
    .select()
    .from(projectGroups)
    .where(eq(projectGroups.id, id))
    .for("update");
  return row ?? refuse("groupNotFound");
}

/**
 * Every group in rank order, with the number of its projects the caller can
 * see. Names are organisational and listed to everyone who works with
 * projects; a group none of whose projects is visible counts 0.
 */
export async function listGroups(): Promise<ProjectGroupSummary[]> {
  await requireProjectUser();
  const visible = await projectScope(projects.id);
  return db
    .select({
      id: projectGroups.id,
      name: projectGroups.name,
      rank: projectGroups.rank,
      projectCount: sql<number>`count(${projects.id})::int`,
    })
    .from(projectGroups)
    .leftJoin(projects, and(eq(projects.groupId, projectGroups.id), visible))
    .groupBy(projectGroups.id)
    .orderBy(asc(projectGroups.rank), asc(projectGroups.name));
}

/** A new group, ranked last. 409 `groupNameTaken` for a name already used. */
export async function createGroup(input: {
  name: string;
}): Promise<ProjectGroup> {
  const session = await requireManageGroups();
  const { name } = parsed(projectGroupInputSchema.safeParse(input));
  const created = await uniqueName(() =>
    db.transaction(async (tx) => {
      await lockRanks(tx);
      if (await nameTaken(tx, name)) await refuse("groupNameTaken");
      const [last] = await tx
        .select({ rank: projectGroups.rank })
        .from(projectGroups)
        .orderBy(desc(projectGroups.rank))
        .limit(1);
      return one(
        await tx
          .insert(projectGroups)
          .values({ name, rank: generateKeyBetween(last?.rank ?? null, null) })
          .returning(),
        "project group"
      );
    })
  );
  await recordActivity({
    actorId: session.user.id,
    action: "projectGroup.created",
    entityType: "projectGroup",
    entityId: created.id,
    data: { group: created.name },
  });
  return created;
}

export async function renameGroup(
  id: string,
  input: { name: string }
): Promise<ProjectGroup> {
  const session = await requireManageGroups();
  const { name } = parsed(projectGroupInputSchema.safeParse(input));
  await groupId(id);
  const { before, renamed } = await uniqueName(() =>
    db.transaction(async (tx) => {
      const current = await lockGroup(tx, id);
      if (await nameTaken(tx, name, id)) await refuse("groupNameTaken");
      const renamed = one(
        await tx
          .update(projectGroups)
          .set({ name, updatedAt: new Date() })
          .where(eq(projectGroups.id, id))
          .returning(),
        "project group"
      );
      return { before: current, renamed };
    })
  );
  if (before.name !== renamed.name) {
    await recordActivity({
      actorId: session.user.id,
      action: "projectGroup.renamed",
      entityType: "projectGroup",
      entityId: id,
      data: { from: before.name, to: renamed.name },
    });
  }
  return renamed;
}

/**
 * Move a group between new neighbours: after `after`, before `before`. Given
 * one, the other side is the group adjacent to it. Only the moved row is
 * written (a fractional-index rank between the two).
 */
export async function reorderGroup(
  id: string,
  input: { before?: string; after?: string }
): Promise<ProjectGroup> {
  const session = await requireManageGroups();
  const result = projectGroupReorderSchema.safeParse(input);
  if (!result.success) return refuse("groupReorderInvalid");
  const { before, after } = result.data;
  if (
    (before === undefined && after === undefined) ||
    before === id ||
    after === id ||
    (before !== undefined && before === after)
  ) {
    return refuse("groupReorderInvalid");
  }
  await groupId(id);
  const moved = await db.transaction(async (tx) => {
    await lockRanks(tx);
    const group = await lockGroup(tx, id);
    const rankOf = async (neighbour: string | undefined) => {
      if (neighbour === undefined) return undefined;
      const [row] = await tx
        .select({ rank: projectGroups.rank })
        .from(projectGroups)
        .where(eq(projectGroups.id, neighbour))
        .limit(1);
      return row?.rank ?? refuse("groupNotFound");
    };
    const afterRank = await rankOf(after);
    const beforeRank = await rankOf(before);
    const others = ne(projectGroups.id, id);
    let low = afterRank ?? null;
    let high = beforeRank ?? null;
    if (afterRank === undefined && beforeRank !== undefined) {
      const [prev] = await tx
        .select({ rank: projectGroups.rank })
        .from(projectGroups)
        .where(and(others, lt(projectGroups.rank, beforeRank)))
        .orderBy(desc(projectGroups.rank))
        .limit(1);
      low = prev?.rank ?? null;
    }
    if (beforeRank === undefined && afterRank !== undefined) {
      const [next] = await tx
        .select({ rank: projectGroups.rank })
        .from(projectGroups)
        .where(and(others, gt(projectGroups.rank, afterRank)))
        .orderBy(asc(projectGroups.rank))
        .limit(1);
      high = next?.rank ?? null;
    }
    // Ranks are ASCII, so JS string order is the column's C order.
    if (low !== null && high !== null && low >= high) {
      return refuse("groupReorderInvalid");
    }
    return one(
      await tx
        .update(projectGroups)
        .set({ rank: generateKeyBetween(low, high), updatedAt: new Date() })
        .where(eq(projectGroups.id, group.id))
        .returning(),
      "project group"
    );
  });
  await recordActivity({
    actorId: session.user.id,
    action: "projectGroup.reordered",
    entityType: "projectGroup",
    entityId: id,
    data: { group: moved.name },
  });
  return moved;
}

/**
 * Move every project of `from` into `into`, then delete `from`, in one
 * transaction. Both rows are locked first, in id order (so two merges of the
 * same pair queue instead of deadlocking): `from` FOR UPDATE, since it is
 * deleted, and `into` FOR NO KEY UPDATE, which a project write's foreign-key
 * check (FOR KEY SHARE) does not wait for. A FOR UPDATE on `into` would
 * deadlock with an edit that has already locked a project of `from` and is
 * moving it to `into`: the edit would wait on `into` while the merge waits on
 * the project. A concurrent rename or delete of either group waits (or wins,
 * and the merge answers 404); a project linked to `from` meanwhile (its
 * foreign-key check takes KEY SHARE on `from`) is moved as well.
 */
export async function mergeGroups(input: {
  from: string;
  into: string;
}): Promise<ProjectGroup> {
  const session = await requireManageGroups();
  // Lowercase, as Postgres prints uuids: the self check and the lock order
  // below compare them as strings (hex order is the uuid byte order).
  const ids = parsed(projectGroupMergeSchema.safeParse(input));
  const from = ids.from.toLowerCase();
  const into = ids.into.toLowerCase();
  if (from === into) return refuse("groupMergeSelf");
  const { source, target, count } = await db.transaction(async (tx) => {
    const lock = async (id: string) => {
      const [row] = await tx
        .select()
        .from(projectGroups)
        .where(eq(projectGroups.id, id))
        .for(id === from ? "update" : "no key update");
      return row;
    };
    const [first, second] = from < into ? [from, into] : [into, from];
    const locked = [await lock(first), await lock(second)];
    const source = locked.find((g) => g?.id === from);
    const target = locked.find((g) => g?.id === into);
    if (!source || !target) return refuse("groupNotFound");
    const movedProjects = await tx
      .update(projects)
      .set({ groupId: into })
      .where(eq(projects.groupId, from))
      .returning({ id: projects.id });
    await tx.delete(projectGroups).where(eq(projectGroups.id, from));
    return { source, target, count: movedProjects.length };
  });
  await recordActivity({
    actorId: session.user.id,
    action: "projectGroup.merged",
    entityType: "projectGroup",
    entityId: target.id,
    data: { from: source.name, into: target.name, count },
  });
  return target;
}

/** Delete a group; its projects become ungrouped (ON DELETE SET NULL). */
export async function deleteGroup(id: string): Promise<{ id: string }> {
  const session = await requireManageGroups();
  await groupId(id);
  const { group, count } = await db.transaction(async (tx) => {
    const group = await lockGroup(tx, id);
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(projects)
      .where(eq(projects.groupId, id));
    await tx.delete(projectGroups).where(eq(projectGroups.id, id));
    return { group, count: row?.count ?? 0 };
  });
  await recordActivity({
    actorId: session.user.id,
    action: "projectGroup.deleted",
    entityType: "projectGroup",
    entityId: id,
    data: { group: group.name, count },
  });
  return { id };
}
