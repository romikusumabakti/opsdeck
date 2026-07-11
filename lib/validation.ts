import { z } from "zod";

// Shared input validation for server actions. Actions are POST endpoints
// callable by any authenticated client with arbitrary payloads, so every
// boundary parses its input here rather than trusting the TypeScript types.

export const projectIdSchema = z.uuid();

export const serviceRoleSchema = z.enum(["db", "backend", "frontend"]);
export const serviceActionSchema = z.enum(["start", "stop", "restart"]);

// Backup filenames are echoed back into shell commands (gunzip/psql/sqlcmd
// redirects). They are shq-quoted, but still constrain them to a flat basename
// with a known backup extension so a tampered client can't point restore at an
// arbitrary path (`../../etc/...`) or a non-backup file.
export const backupFilenameSchema = z
  .string()
  .regex(
    /^[\w.-]+\.(sql|sql\.gz|bak)$/,
    "Filename must be a backup basename (.sql, .sql.gz, or .bak) with no path separators"
  )
  .refine((f) => !f.includes(".."), "Filename must not contain '..'");

// Database names are interpolated into SQL identifiers (pg "..." / mssql [...])
// and into shell pipelines (shq-quoted). Both layers escape, but the picker
// also lets the client send an arbitrary `database` for backup/restore/create/
// drop, so constrain it to a conservative identifier — a tampered client can't
// then smuggle control chars, path separators, or shell/SQL metacharacters.
// The project's own configured dbName bypasses this (it's trusted config); only
// a *different*, client-supplied target is validated here.
export const databaseNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9_$-]*$/,
    "Database name must start with a letter, digit, or underscore and contain only letters, digits, underscore, dollar, or hyphen"
  );

// ISO 8601 duration subset the mock-time UI emits: optional `-`, P[n]D, then
// optional T[n]H[n]M[n]S, with at least one component. Mirrors the parser in
// actions/mock-time.ts.
export const isoDurationSchema = z
  .string()
  .regex(
    /^(-?)P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
    "Invalid ISO 8601 duration"
  )
  .refine((d) => d !== "P" && d !== "-P", "Duration must have a component");

// Absolute instant the clock should travel/freeze to.
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

const serviceTypeSchema = z.enum(["docker", "systemd", "kubernetes"]);
const databaseTypeSchema = z.enum(["postgres", "mssql"]);

export const serverInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  host: z.string().trim().min(1).max(255),
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(1024),
  // Absolute path the SFTP explorer is confined to. Optional on input (the
  // column defaults to "/"); must be absolute when provided.
  sftpRoot: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .regex(/^\//, "SFTP root must be an absolute path")
    .optional(),
});

// The logical project (parent). `key` is the uppercase issue-prefix used to
// form human issue keys (CMEM-42) and must stay short + identifier-shaped.
export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z][A-Z0-9]{1,9}$/,
    "Key must be 2–10 uppercase letters/digits, starting with a letter"
  );

export const projectMetaInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  key: projectKeySchema,
  client: z.string().trim().max(120).nullish(),
  description: z.string().trim().max(2000).nullish(),
});
export const projectMetaUpdateSchema = projectMetaInputSchema.partial();
export type ProjectMetaInput = z.infer<typeof projectMetaInputSchema>;

// An environment (deployment) belongs to one logical project.
export const projectInputSchema = z.object({
  // The logical project this deployment belongs to (chosen via the form's
  // project picker).
  projectId: z.uuid(),
  name: z.string().trim().min(1).max(200),

  dbServerId: z.uuid(),
  dbServiceType: serviceTypeSchema,
  dbServiceName: z.string().trim().min(1).max(255),
  dbType: databaseTypeSchema,
  dbName: z.string().trim().min(1).max(255),
  dbPassword: z.string().max(1024).nullish(),
  dbBackupPath: z.string().trim().min(1).max(1024),

  backendServerId: z.uuid(),
  backendServiceType: serviceTypeSchema,
  backendServiceName: z.string().trim().min(1).max(255),
  backendMockTimeApiUrl: z.url().max(2048).nullish(),
  backendMockTimeApiKey: z.string().max(1024).nullish(),

  frontendServerId: z.uuid(),
  frontendServiceType: serviceTypeSchema,
  frontendServiceName: z.string().trim().min(1).max(255),

  // Purpose + owner of this deployment (both optional).
  kind: z.enum(["qa", "dev", "release", "sandbox", "prod"]).nullish(),
  owner: z.string().trim().max(120).nullish(),
});

export const projectUpdateSchema = projectInputSchema.partial();
export const serverUpdateSchema = serverInputSchema.partial();

// =========================
// Issue tracker
// =========================

export const issueStatusSchema = z.enum([
  "open",
  "in_progress",
  "resolved",
  "closed",
]);
export const issueTypeSchema = z.enum(["bug", "task", "story", "epic"]);
export const issuePrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const issueInputSchema = z.object({
  projectId: z.uuid(),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(20_000).default(""),
  type: issueTypeSchema.default("task"),
  priority: issuePrioritySchema.default("medium"),
  // Optional deployment where the issue was observed.
  environmentId: z.uuid().nullish(),
  assigneeId: z.uuid().nullish(),
  milestoneId: z.uuid().nullish(),
  parentId: z.uuid().nullish(),
});
export type IssueInput = z.infer<typeof issueInputSchema>;

export const issueUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(20_000).optional(),
  status: issueStatusSchema.optional(),
  type: issueTypeSchema.optional(),
  priority: issuePrioritySchema.optional(),
  environmentId: z.uuid().nullish(),
  assigneeId: z.uuid().nullish(),
  milestoneId: z.uuid().nullish(),
  parentId: z.uuid().nullish(),
});

// A recorded QA test result against the issue's environment.
export const testRunSchema = z.object({
  issueId: z.uuid(),
  passed: z.boolean(),
  note: z.string().trim().max(20_000).optional(),
});
export type TestRunInput = z.infer<typeof testRunSchema>;

export const milestoneInputSchema = z.object({
  projectId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  // Accepts an ISO string from the client; coerced to a Date. Nullable to clear.
  dueAt: z.coerce.date().nullish(),
});
export type MilestoneInput = z.infer<typeof milestoneInputSchema>;

export type ServerInput = z.infer<typeof serverInputSchema>;
export type ProjectInput = z.infer<typeof projectInputSchema>;

// =========================
// Storage explorer
// =========================

export const s3ConnectionInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  endpoint: z.url().max(2048),
  region: z.string().trim().min(1).max(100),
  bucket: z.string().trim().min(1).max(255),
  accessKeyId: z.string().trim().min(1).max(512),
  secretKey: z.string().min(1).max(1024),
  forcePathStyle: z.boolean(),
});

// Update allows omitting secretKey ("leave blank to keep"); everything else is
// individually optional so partial edits round-trip.
export const s3ConnectionUpdateSchema = s3ConnectionInputSchema
  .partial()
  .extend({ secretKey: z.string().min(1).max(1024).optional() });

export type S3ConnectionInput = z.infer<typeof s3ConnectionInputSchema>;

// A browsed location. `kind` selects the backend; the id names the connection
// or server. Credentials are NEVER part of this — the action layer loads them.
export const explorerSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("s3"), connectionId: z.uuid() }),
  z.object({ kind: z.literal("sftp"), serverId: z.uuid() }),
]);

// An untrusted path/key from the client. Bounded length; the backends' own
// normalizeS3Key / confineSftpPath enforce the real traversal defence. Reject
// NUL bytes here since neither a key nor a filesystem path may contain one.
export const explorerPathSchema = z
  .string()
  .max(4096)
  .refine((p) => !p.includes("\0"), "Path must not contain NUL");

// A single path segment (folder/file name) typed for mkdir/rename. No slashes,
// no traversal, no control chars — the caller joins it onto a validated parent.
export const explorerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^/\\\r\n\t]+$/, "Name must not contain path separators")
  .refine((n) => n !== "." && n !== "..", "Reserved name");

// =========================
// Team Knowledge Base
// =========================

export const knowledgeIdSchema = z.uuid();

// Slugs are interpolated into URLs and queried with `eq`. Constrain to a
// lowercase kebab token so they stay URL-safe and collision checks are stable.
export const knowledgeSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Slug must be lowercase letters, digits, and single hyphens"
  );

export const collectionInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  icon: z.string().trim().max(60).nullish(),
  description: z.string().trim().max(500).nullish(),
});
export const collectionUpdateSchema = collectionInputSchema.partial();

export const collectionMoveSchema = z.object({
  collectionId: z.uuid(),
  // Fractional-index rank computed client-side from the drop neighbours.
  rank: z.string().min(1).max(100),
});

export const documentInputSchema = z.object({
  collectionId: z.uuid(),
  parentId: z.uuid().nullish(),
  title: z.string().trim().min(1).max(255),
  // Markdown body. Generous ceiling — these are wiki pages, not blobs.
  content: z.string().max(500_000).default(""),
  projectId: z.uuid().nullish(),
  // null = draft, ISO date = published. Optional; absent defaults to draft.
  publishedAt: z.union([z.iso.datetime({ offset: true }), z.null()]).optional(),
});

export const documentUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(255),
    content: z.string().max(500_000),
    parentId: z.uuid().nullish(),
    collectionId: z.uuid(),
    projectId: z.uuid().nullish(),
    // null = unpublish (back to draft), Date = publish.
    publishedAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
    // Optimistic-concurrency token: the version the editor loaded. When present
    // the update is rejected if the stored version moved (concurrent edit).
    expectedVersion: z.number().int().nonnegative(),
  })
  .partial();

// Reorder/move payload for drag-and-drop in the tree. collectionId is the
// destination collection (a drop can cross collections); the action cascades it
// to the moved subtree so grouping stays consistent.
export const documentMoveSchema = z.object({
  documentId: z.uuid(),
  collectionId: z.uuid(),
  parentId: z.uuid().nullish(),
  // Fractional-index rank string computed client-side from the drop neighbours.
  rank: z.string().min(1).max(100),
});

// Search box input. websearch_to_tsquery tolerates arbitrary text, but bound
// the length so a pathological query can't pin the planner.
export const knowledgeSearchSchema = z.string().trim().min(1).max(200);

// Attachment upload ceiling. 10 MB is generous for screenshots/diagrams while
// bounding the request body the upload route buffers whole in memory. Originals
// rarely need more — imgproxy downscales on read (see the GET asset route), so
// the stored bytes are never served at full size. The route also magic-byte
// sniffs the bytes (raster only — SVG is rejected as an XSS vector).
export const KNOWLEDGE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

// Issue attachments accept any file (logs, screenshots, PDFs), served as a
// download — so no image sniffing, just a hard size ceiling.
export const ISSUE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const issueIdSchema = z.uuid();

export type CollectionInput = z.infer<typeof collectionInputSchema>;
export type DocumentInput = z.infer<typeof documentInputSchema>;
export type DocumentUpdate = z.infer<typeof documentUpdateSchema>;
