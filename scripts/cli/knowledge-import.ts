// The work of `menara knowledge import` (arguments: scripts/cli/knowledge.ts).
// Every write goes through the knowledge service cores as the --as user, so
// the same permission and visibility rules apply as in the app. The folder is
// checked whole before anything is written: one problem anywhere stops the run.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type KnowledgeCollection,
  type KnowledgeDocument,
  knowledgeCollections,
  knowledgeDocuments,
  users,
} from "@/lib/db/schema";
import { slugify } from "@/lib/knowledge-text";
import {
  canOrg,
  isOrgRole,
  normalizeOrgRole,
  ORG_ROLES,
  type OrgRole,
} from "@/lib/permissions";
import { docTypeSchema, knowledgeSlugSchema } from "@/lib/validation";
import {
  createCollectionFor,
  createDocumentFor,
  type KnowledgeActor,
  updateCollectionFor,
  updateDocumentFor,
} from "@/server/services/knowledge";

type DocType = (typeof docTypeSchema.options)[number];

/** One file of the folder, as its front matter and body declare it. */
export interface ImportFile {
  file: string;
  collection: string;
  title: string;
  slug: string;
  docType: DocType;
  // undefined = not declared by this file; [] = everyone.
  visibleTo: OrgRole[] | undefined;
  body: string;
}

const KEYS = ["collection", "title", "slug", "docType", "visibleTo"];
const FRONT_MATTER = /^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/;

const rolesText = (roles: readonly string[]) =>
  roles.length === 0 ? "everyone" : roles.join(", ");

/** A file's front matter and body, or every problem found in it. */
export function parseImportFile(
  file: string,
  text: string
): { doc?: ImportFile; problems: string[] } {
  const source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = FRONT_MATTER.exec(source);
  if (!match) {
    return {
      problems: [`${file}: no YAML front matter (--- … --- at the top)`],
    };
  }
  let meta: unknown;
  try {
    meta = Bun.YAML.parse(match[1] ?? "") ?? {};
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { problems: [`${file}: invalid YAML front matter (${reason})`] };
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return { problems: [`${file}: the front matter must be key: value pairs`] };
  }
  const fields = meta as Record<string, unknown>;
  // A misspelt key (visibleto) would otherwise silently mean "everyone".
  const problems = Object.keys(fields)
    .filter((key) => !KEYS.includes(key))
    .map((key) => `${file}: unknown front matter key "${key}"`);

  const requiredText = (key: string, max: number): string | undefined => {
    const value = fields[key];
    if (value === undefined || value === null || value === "") {
      problems.push(`${file}: ${key} is required`);
      return undefined;
    }
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`${file}: ${key} must be text`);
      return undefined;
    }
    if (value.trim().length > max) {
      problems.push(`${file}: ${key} is longer than ${max} characters`);
      return undefined;
    }
    return value.trim();
  };
  const collection = requiredText("collection", 120);
  const title = requiredText("title", 255);

  let slug = title === undefined ? undefined : slugify(title);
  if (fields.slug !== undefined) {
    const parsed = knowledgeSlugSchema.safeParse(fields.slug);
    if (parsed.success) slug = parsed.data;
    else {
      problems.push(
        `${file}: slug must be lowercase letters, digits and single hyphens`
      );
    }
  }

  let docType: DocType = "doc";
  if (fields.docType !== undefined) {
    const parsed = docTypeSchema.safeParse(fields.docType);
    if (parsed.success) docType = parsed.data;
    else {
      problems.push(
        `${file}: docType must be one of ${docTypeSchema.options.join(", ")}`
      );
    }
  }

  let visibleTo: OrgRole[] | undefined;
  if ("visibleTo" in fields) {
    const value = fields.visibleTo ?? [];
    if (!Array.isArray(value)) {
      problems.push(`${file}: visibleTo must be a list of roles`);
    } else {
      const wanted = new Set<string>();
      for (const role of value) {
        if (typeof role !== "string" || !isOrgRole(role)) {
          problems.push(`${file}: visibleTo has an unknown role "${role}"`);
        } else if (role === "admin") {
          problems.push(
            `${file}: visibleTo cannot list "admin" (admins always see every collection)`
          );
        } else {
          wanted.add(role);
        }
      }
      // Stored as the app stores it: deduplicated, in ORG_ROLES order.
      visibleTo = ORG_ROLES.filter((role) => wanted.has(role));
    }
  }

  const body = source.slice(match[0].length).trim();
  if (body.length > 500_000) {
    problems.push(`${file}: the body is longer than 500000 characters`);
  }

  if (
    problems.length > 0 ||
    collection === undefined ||
    title === undefined ||
    slug === undefined
  ) {
    return { problems };
  }
  return {
    doc: { file, collection, title, slug, docType, visibleTo, body },
    problems,
  };
}

/**
 * Point `[text](other.md)` and `[text](./other.md#section)` at
 * `/knowledge/<slug>` when other.md is one of the imported files (the section
 * is dropped: the app's internal links and backlinks are by slug alone).
 * External URLs, paths outside the folder, unknown files, images and anything
 * inside code stay as written.
 */
export function rewriteImportLinks(
  body: string,
  slugByFile: ReadonlyMap<string, string>
): string {
  const rewrite = (text: string) =>
    text.replace(
      /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g,
      (whole, label: string, target: string) => {
        const local = /^(?:\.\/)?([^/#?:]+\.md)(?:#[^)]*)?$/.exec(target);
        const slug = local?.[1] ? slugByFile.get(local[1]) : undefined;
        return slug ? `[${label}](/knowledge/${slug})` : whole;
      }
    );
  // Code (fenced blocks, inline spans) is copied as is; the rest rewritten.
  const code = /```[\s\S]*?```|`[^`\n]*`/g;
  let result = "";
  let last = 0;
  for (const m of body.matchAll(code)) {
    result += rewrite(body.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return result + rewrite(body.slice(last));
}

export interface ImportOptions {
  folder: string;
  asEmail: string;
  dryRun: boolean;
  updateVisibility: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
}

async function findActor(
  email: string,
  problems: string[]
): Promise<KnowledgeActor | undefined> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      banned: users.banned,
    })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  if (!user) {
    problems.push(`--as: no user with the email "${email}"`);
    return undefined;
  }
  if (user.banned) {
    problems.push(`--as: ${user.email} is deactivated`);
    return undefined;
  }
  const role = normalizeOrgRole(user.role);
  if (!canOrg(role, { knowledge: ["manage"] })) {
    problems.push(
      `--as: ${user.email} (${role}) does not hold knowledge:manage`
    );
    return undefined;
  }
  return { userId: user.id, role };
}

const sameRoles = (a: readonly string[], b: readonly string[]) =>
  [...new Set(a)].sort().join(",") === [...new Set(b)].sort().join(",");

/** Runs the import; the exit code: 0, or 1 on any problem or refusal. */
export async function importKnowledge(opts: ImportOptions): Promise<number> {
  const { folder, dryRun, out, err } = opts;
  let names: string[];
  try {
    names = (await readdir(folder, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    err(`cannot read the folder ${folder}: ${reason}`);
    return 1;
  }
  if (names.length === 0) {
    err(`no *.md files in ${folder}`);
    return 1;
  }

  // --- Check everything first -----------------------------------------------
  const problems: string[] = [];
  const actor = await findActor(opts.asEmail, problems);
  const docs: ImportFile[] = [];
  for (const name of names) {
    const parsed = parseImportFile(
      name,
      await readFile(join(folder, name), "utf8")
    );
    problems.push(...parsed.problems);
    if (parsed.doc) docs.push(parsed.doc);
  }

  const bySlug = Map.groupBy(docs, (doc) => doc.slug);
  for (const [slug, group] of bySlug) {
    if (group.length > 1) {
      problems.push(
        `${group.map((d) => d.file).join(", ")}: ${group.length === 2 ? "both" : "all"} resolve to the slug "${slug}"`
      );
    }
  }

  // The collections in order of their first file, with the one visibleTo the
  // run declares for each (undefined when no file declares one).
  const declared = new Map<string, OrgRole[] | undefined>();
  for (const [collection, group] of Map.groupBy(docs, (d) => d.collection)) {
    const declaring = group.filter((d) => d.visibleTo !== undefined);
    const lists = new Set(declaring.map((d) => rolesText(d.visibleTo ?? [])));
    if (lists.size > 1) {
      problems.push(
        `collection "${collection}": the files declare different visibleTo (${declaring
          .map((d) => `${d.file}: ${rolesText(d.visibleTo ?? [])}`)
          .join("; ")})`
      );
    }
    declared.set(collection, declaring[0]?.visibleTo);
  }

  const collectionNames = [...declared.keys()];
  const existingCollections = await db
    .select()
    .from(knowledgeCollections)
    .where(inArray(knowledgeCollections.name, collectionNames));
  const collectionByName = new Map<string, KnowledgeCollection>();
  for (const [name, group] of Map.groupBy(existingCollections, (c) => c.name)) {
    if (group.length > 1) {
      problems.push(
        `collection "${name}": ${group.length} collections have this name; rename all but one first`
      );
    }
    if (group[0]) collectionByName.set(name, group[0]);
  }

  const existingDocs =
    docs.length === 0
      ? []
      : await db
          .select({
            doc: knowledgeDocuments,
            collection: knowledgeCollections.name,
          })
          .from(knowledgeDocuments)
          .innerJoin(
            knowledgeCollections,
            eq(knowledgeCollections.id, knowledgeDocuments.collectionId)
          )
          .where(
            inArray(
              knowledgeDocuments.slug,
              docs.map((d) => d.slug)
            )
          );
  const existingBySlug = new Map(
    existingDocs.map((row) => [row.doc.slug, row])
  );
  for (const doc of docs) {
    const existing = existingBySlug.get(doc.slug);
    const target = collectionByName.get(doc.collection);
    // No moves via import: a slug is the document's identity across runs.
    if (existing && existing.doc.collectionId !== target?.id) {
      problems.push(
        `${doc.file}: the slug "${doc.slug}" belongs to a document in another collection ("${existing.collection}")`
      );
    }
  }

  if (problems.length > 0 || !actor) {
    for (const problem of problems) err(problem);
    err(
      `nothing imported: ${problems.length} problem${problems.length === 1 ? "" : "s"}`
    );
    return 1;
  }

  // --- Collections ------------------------------------------------------------
  const collectionIds = new Map<string, string | undefined>();
  const refusedCollections = new Map<string, string>();
  for (const [name, roles] of declared) {
    const existing = collectionByName.get(name);
    if (!existing) {
      out(`create collection "${name}" (visible to ${rolesText(roles ?? [])})`);
      if (!dryRun) {
        const created = await createCollectionFor(actor, {
          name,
          visibleToRoles: roles ?? [],
        });
        if (!created.success) throw new Error(created.message);
        collectionIds.set(name, created.data?.id);
      }
      continue;
    }
    collectionIds.set(name, existing.id);
    if (roles === undefined || sameRoles(existing.visibleToRoles, roles)) {
      continue;
    }
    const change = `${rolesText(existing.visibleToRoles)} → ${rolesText(roles)}`;
    if (!opts.updateVisibility) {
      refusedCollections.set(
        name,
        `collection "${name}" is visible to ${rolesText(existing.visibleToRoles)}, the files say ${rolesText(roles)}; rerun with --update-visibility to apply it`
      );
      continue;
    }
    out(`update collection "${name}" visibility: ${change}`);
    if (!dryRun) {
      const updated = await updateCollectionFor(actor, existing.id, {
        visibleToRoles: roles,
      });
      if (!updated.success) throw new Error(updated.message);
    }
  }

  // --- Documents --------------------------------------------------------------
  const slugByFile = new Map(docs.map((d) => [d.file, d.slug]));
  const tally = { created: 0, updated: 0, unchanged: 0, refused: 0 };
  const publishedAt = new Date().toISOString();
  for (const doc of docs) {
    const refusal = refusedCollections.get(doc.collection);
    if (refusal) {
      out(`refused ${doc.file} → ${doc.slug} (${refusal})`);
      tally.refused++;
      continue;
    }
    const content = rewriteImportLinks(doc.body, slugByFile);
    const existing: KnowledgeDocument | undefined = existingBySlug.get(
      doc.slug
    )?.doc;
    if (
      existing &&
      existing.title === doc.title &&
      existing.content === content &&
      existing.docType === doc.docType &&
      existing.publishedAt !== null
    ) {
      out(`unchanged ${doc.file} → ${doc.slug}`);
      tally.unchanged++;
      continue;
    }
    let slug = doc.slug;
    if (!dryRun) {
      const result = existing
        ? await updateDocumentFor(
            actor,
            existing.id,
            {
              title: doc.title,
              content,
              docType: doc.docType,
              ...(existing.publishedAt === null ? { publishedAt } : {}),
            },
            { slug: doc.slug }
          )
        : await createDocumentFor(
            actor,
            {
              collectionId: collectionIds.get(doc.collection),
              title: doc.title,
              docType: doc.docType,
              content,
              publishedAt,
            },
            { slug: doc.slug }
          );
      if (!result.success) {
        out(`refused ${doc.file} → ${doc.slug} (${result.message})`);
        tally.refused++;
        continue;
      }
      slug = result.data?.slug ?? slug;
    }
    const verb = existing ? "updated" : "created";
    out(`${verb} ${doc.file} → ${slug}`);
    tally[verb]++;
  }

  out(
    `${dryRun ? "dry run" : "imported"}: ${tally.created} created, ${tally.updated} updated, ${tally.unchanged} unchanged, ${tally.refused} refused${dryRun ? " (nothing written)" : ""}`
  );
  return tally.refused > 0 ? 1 : 0;
}
