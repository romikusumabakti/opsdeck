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
});

export const projectInputSchema = z.object({
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
});

export const projectUpdateSchema = projectInputSchema.partial();
export const serverUpdateSchema = serverInputSchema.partial();

export type ServerInput = z.infer<typeof serverInputSchema>;
export type ProjectInput = z.infer<typeof projectInputSchema>;
