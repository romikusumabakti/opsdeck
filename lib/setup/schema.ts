import { z } from "zod";
import {
  branchSchema,
  componentKeySchema,
  composeServiceSchema,
  deployDirSchema,
  envVarNameSchema,
  healthTimeoutSchema,
  healthUrlSchema,
  preStartCommandSchema,
  servicesSchema,
  tagVariableSchema,
} from "@/lib/deploy/validation";
import {
  domainLabelSchema,
  entryPortSchema,
  externalHostnameSchema,
} from "@/lib/domains/validation";
import { sharedDatabaseNameSchema } from "@/lib/validation";

// The setup wizard's input: one environment of an app with its deploy
// targets, database, variables and domain, created in one request
// (server/services/environment-setup). Shapes only, shared by the client
// forms and the API; the rules that need the database (placement, ports,
// names in use, copy permissions) are the service's, which reports them as
// issues in the preview.

const targetSchema = z
  .object({
    componentKey: componentKeySchema,
    sourceBranch: branchSchema,
    autoDeploy: z.boolean().default(false),
    deployDir: deployDirSchema,
    services: servicesSchema,
    tagVariable: tagVariableSchema.default("IMAGE_TAG"),
    preStartCommand: preStartCommandSchema.nullish(),
    healthUrl: healthUrlSchema.nullish(),
    healthTimeoutSeconds: healthTimeoutSchema.default(180),
    backupBeforeDeploy: z.boolean().default(false),
  })
  .strict();

/** The roles a setup binds besides `db` (which comes from `database`). */
export const SETUP_SERVICE_ROLES = [
  "backend",
  "frontend",
  "worker",
  "cache",
  "gateway",
] as const;
export type SetupServiceRole = (typeof SETUP_SERVICE_ROLES)[number];

const serviceBindingSchema = z
  .object({
    role: z.enum(SETUP_SERVICE_ROLES),
    // The environment form's service-name rule.
    serviceName: z.string().trim().min(1).max(255),
  })
  .strict();

const databaseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("shared"),
      databaseHostId: z.uuid(),
      dbName: sharedDatabaseNameSchema,
      dbRole: sharedDatabaseNameSchema,
      passwordVariable: envVarNameSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("container"),
      // The container's name on the deploy server (service control, logs).
      serviceName: z.string().trim().min(1).max(255),
    })
    .strict(),
  z.object({ kind: z.literal("external") }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

const variableSchema = z
  .object({
    // Name and value rules are the service's, so the preview says which.
    name: z.string().min(1).max(128),
    kind: z.enum(["plain", "secret", "generated"]),
    value: z.string().optional(),
    copy: z.boolean().optional(),
  })
  .strict();

const domainSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("tunnel"),
      zoneId: z.uuid(),
      label: domainLabelSchema,
      // null = public, which needs org server:manage.
      accessPolicyId: z.string().trim().min(1).max(255).nullable(),
      entryPort: entryPortSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external"),
      hostname: externalHostnameSchema,
    })
    .strict(),
]);

export const environmentSetupInputSchema = z
  .object({
    projectId: z.uuid(),
    appId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    kind: z.enum(["qa", "dev", "release", "sandbox", "prod"]).nullish(),
    ownerId: z.uuid().nullish(),
    copyFromEnvironmentId: z.uuid().nullish(),
    server: z.object({ serverId: z.uuid() }).strict(),
    // One per component of the app, all on `server`.
    targets: z.array(targetSchema).min(1).max(20),
    // The containers service control and logs act on, by role (Docker
    // container names, e.g. `hris-staging-backend-1`); the db one comes from
    // `database`. Each role at most once.
    services: z
      .array(serviceBindingSchema)
      .max(SETUP_SERVICE_ROLES.length)
      .refine(
        (list) => new Set(list.map((s) => s.role)).size === list.length,
        "Duplicate service role"
      ),
    // The compose service the domain routes to, when known (repo detection);
    // only steers the suggested roles.
    entryService: composeServiceSchema.nullish(),
    database: databaseSchema,
    variables: z.array(variableSchema).max(200).default([]),
    domain: domainSchema,
  })
  .strict();

export type EnvironmentSetupInput = z.infer<typeof environmentSetupInputSchema>;
export type EnvironmentSetupTarget = z.infer<typeof targetSchema>;

/** One refused check: `field` is a dotted path into the input. */
export type SetupIssue = { field: string; code: string };
