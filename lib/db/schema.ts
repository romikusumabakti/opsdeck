import {
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AccentColor } from "@/lib/accents";
import type { BuildSpec } from "@/lib/ci/build-spec";
import type { PipelineFileCommits } from "@/lib/ci/types";
import type { MotifPreference } from "@/lib/motifs";
import type { ServerPreflight } from "@/lib/provisioning/preflight";
import type { WorkingHours } from "@/lib/user-display";

// Constraint names are spelled out wherever they differ from drizzle-kit's
// defaults: they are the names the legacy migrations (squashed into the baseline) gave
// the live databases, which drizzle/00000000000000_baseline reproduces.

export const serviceTypeEnum = pgEnum("service_type", [
  "docker",
  "systemd",
  "kubernetes",
]);
// `mysql` covers MariaDB too: the two share a wire protocol and mysqldump
// output, so one value keeps cross-environment restores between them legal and
// avoids duplicating every dbType branch. The remote command builders probe for
// the MariaDB-renamed binaries (mariadb/mariadb-dump) before the mysql* names.
export const databaseTypeEnum = pgEnum("database_type", [
  "postgres",
  "mssql",
  "mysql",
]);
// Role a service plays within its environment. `db`/`backend`/`frontend` match
// lib/services.ts ServiceRole; `worker`/`cache`/`gateway` are seeded so adding
// them needs no enum migration. An environment owns 1..N services, one per
// deployable unit — this replaces the old hardcoded db+backend+frontend triple.
export const serviceRoleEnum = pgEnum("service_role", [
  "db",
  "backend",
  "frontend",
  "worker",
  "cache",
  "gateway",
]);
export const issueStatusEnum = pgEnum("issue_status", [
  "open",
  "in_progress",
  "resolved",
  "closed",
]);
// Kind of work an issue represents. `epic`/`story` pair with `parentId` to nest
// epic → story → subtask; `bug`/`task` are the leaf everyday kinds.
export const issueTypeEnum = pgEnum("issue_type", [
  "bug",
  "task",
  "story",
  "epic",
]);
export const issuePriorityEnum = pgEnum("issue_priority", [
  "low",
  "medium",
  "high",
  "urgent",
]);
// Which Jira deployment a connection points at. Only the auth scheme and a few
// endpoint paths differ, so one client covers both: `cloud` authenticates with
// HTTP Basic (email + API token), `datacenter` with a Bearer PAT.
export const jiraFlavorEnum = pgEnum("jira_flavor", ["cloud", "datacenter"]);
// Outcome of the last sync sweep for a linked project. `partial` = some issues
// applied and at least one failed; the sweep cursor only advances past issues
// that actually applied, so the next sweep retries the rest.
export const jiraSyncStatusEnum = pgEnum("jira_sync_status", [
  "ok",
  "partial",
  "failed",
]);
// Why an environment exists — lets the grid/switcher label the 1..N deployments
// of a project by purpose (a QA's own copy, a frontend dev's, a devops sandbox)
// instead of an opaque host suffix.
export const environmentKindEnum = pgEnum("environment_kind", [
  "qa",
  "dev",
  "release",
  "sandbox",
  "prod",
]);

// All IDs use UUIDv7 (RFC 9562, May 2024) — time-ordered random UUIDs that
// preserve B-tree index locality unlike v4. Default value uses Postgres 18's
// built-in `uuidv7()` function for tables we own; better-auth tables generate
// IDs in JS via `uuid` package (configured in lib/auth.ts).

// Who may place an environment on a server: "restricted" needs project
// environment:create plus org server:manage (today's rule); "open" also admits
// project QA and above.
export const serverPlacementEnum = pgEnum("server_placement", [
  "restricted",
  "open",
]);

// Where a db service's database lives: "shared" is a database host's
// container, "container" a Postgres container of its own, "external" a server
// the Panel does not manage.
export const databaseKindEnum = pgEnum("database_kind", [
  "shared",
  "container",
  "external",
]);

export const provisioningStepKindEnum = pgEnum("provisioning_step_kind", [
  "prepare_deploy_dir",
  "create_database",
  "deploy",
  "tunnel_route",
  "access_app",
  "dns_record",
]);

// How an environment's public hostname reaches it: through a remotely-managed
// tunnel the Panel edits, or outside the Panel's reach ("external"). No
// environment_domains row means no domain.
export const domainKindEnum = pgEnum("domain_kind", ["tunnel", "external"]);

export const provisioningStepStatusEnum = pgEnum("provisioning_step_status", [
  "pending",
  "running",
  "done",
  "failed",
]);

// How the Panel signs in to a server: with the stored password, or with the
// instance's SSH key.
export const serverAuthEnum = pgEnum("server_auth", ["password", "key"]);

// "current" signs in and is installed on servers; "previous" is still
// accepted while servers move to a newer key; "retired" is kept for history.
export const sshKeyStatusEnum = pgEnum("ssh_key_status", [
  "current",
  "previous",
  "retired",
]);

// The instance's own ed25519 key pair. The private key is encrypted with
// lib/secrets.ts and never leaves the server.
export const sshKeys = pgTable(
  "ssh_keys",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // OpenSSH format: "ssh-ed25519 AAAA...".
    publicKey: text("public_key").notNull(),
    privateKey: text("private_key").notNull(),
    // "SHA256:..." of the public key.
    fingerprint: text("fingerprint").notNull(),
    status: sshKeyStatusEnum("status").notNull().default("current"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ssh_keys_one_current_idx")
      .on(t.status)
      .where(sql`status = 'current'`),
  ]
);

export const servers = pgTable("servers", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),
  host: text("host").notNull(),
  username: text("username").notNull(),
  auth: serverAuthEnum("auth").notNull().default("password"),
  // Null once the server signs in with the instance key.
  password: text("password"),
  // Pinned host key (trust on first use): algorithm, base64 blob and its
  // SHA256 fingerprint. Null until first pinned.
  hostKeyType: text("host_key_type"),
  hostKey: text("host_key"),
  hostKeyFingerprint: text("host_key_fingerprint"),
  hostKeyPinnedAt: timestamp("host_key_pinned_at"),
  // The key the server offered when it did not match the pinned one: type,
  // base64 blob and fingerprint. Trusting it copies exactly this key into the
  // pin.
  hostKeyOfferedType: text("host_key_offered_type"),
  hostKeyOffered: text("host_key_offered"),
  hostKeyOfferedFingerprint: text("host_key_offered_fingerprint"),
  sshKeyId: uuid("ssh_key_id").references(() => sshKeys.id, {
    onDelete: "set null",
  }),
  // Address the installed key is restricted to (authorized_keys from=).
  sshFrom: text("ssh_from"),
  // Stable code of the last key install or login failure.
  keyError: text("key_error"),
  // Root the SFTP file explorer is confined to (see lib/explorer/confineSftpPath).
  // Defaults to "/" (whole host as the SSH user). Narrow it per server — e.g.
  // "/home/deploy" or "/var/www" — to limit the blast radius of the explorer.
  sftpRoot: text("sftp_root").notNull().default("/"),
  placement: serverPlacementEnum("placement").notNull().default("restricted"),
  // Infra only: the terminal and the file explorer stay with org admin/infra;
  // the engineer grant (lib/permissions#canOrgAccessTarget) does not reach it.
  // Set on hosts whose shell reaches the Panel's own secrets (its own host).
  infraOnly: boolean("infra_only").notNull().default(false),
  // Last preflight scan (non-secret facts) and when it ran; null until the
  // server has been scanned.
  preflight: jsonb("preflight").$type<ServerPreflight>(),
  preflightAt: timestamp("preflight_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// A Postgres container on a server that environments can share; the Panel
// creates a database and role inside it.
export const databaseHosts = pgTable(
  "database_hosts",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // restrict: a server backing a database host can't be deleted.
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, {
        name: "database_hosts_server_id_fkey",
        onDelete: "restrict",
      }),
    containerName: text("container_name").notNull(),
    // Where backups are written, as a path inside the container.
    backupPath: text("backup_path").notNull(),
    label: text("label").notNull(),
    // The Docker network the container is reachable on from other containers
    // on the server; null when unknown. Format enforced by a check constraint
    // (see the setup_wizard migration).
    network: text("network"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("database_hosts_server_container_idx").on(
      t.serverId,
      t.containerName
    ),
    // FK index: the onDelete:restrict check scans by server.
    index("database_hosts_server_idx").on(t.serverId),
    check(
      "database_hosts_network_format",
      sql`${t.network} is null or ${t.network} ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'`
    ),
  ]
);

// The real, logical project — one application (e.g. "Common Membership",
// "TMLI Portal"), independent of how many times it is deployed. An issue
// tracker, knowledge, and members hang off THIS, not off a deployment. Each
// project owns one or more `environments` (the concrete server/db/backend/
// frontend triples that used to each be a top-level "project" row).
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),
  // Short stable identifier used as the issue-key prefix (e.g. "CMEM" -> CMEM-42)
  // and in URLs. Uppercase, unique across all projects.
  key: text("key").notNull().unique("projects_key_unique"),
  // Optional grouping label for the owning client/tenant (e.g. "DPLK", "TMLI").
  // A plain nullable column, not a table — promote to `clients` only if per-client
  // access control is ever needed. Keeps the model two-level, not three.
  client: text("client"),
  description: text("description"),
  // The server new environments of this project deploy to by default. Cleared
  // when the server is deleted.
  defaultServerId: uuid("default_server_id").references(() => servers.id, {
    name: "projects_default_server_id_fkey",
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// A concrete deployment of a project — the server/db/backend/frontend triple a
// QA, a frontend dev, or devops runs. This is what used to be a top-level
// "project" row; runs (backups/restores/mock-time) act on ONE environment.
export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, {
        name: "environments_project_id_projects_id_fk",
        onDelete: "cascade",
      }),
    name: text("name").notNull(),
    // URL-friendly identifier, unique within a project. Lowercase. Kept stable
    // across renames so a shared link doesn't rot. Routed as /[key]/[slug]/….
    slug: text("slug").notNull(),

    // --- Purpose / ownership (both optional) ---
    // What this deployment is for; drives the kind badge in the grid/switcher.
    kind: environmentKindEnum("kind"),
    // The user who owns this deployment: someone eligible to be an issue
    // assignee in its project (see lib/assignees#assignableUsersWhere). A
    // display relation, not an access grant. An offboarded (banned) owner
    // stays linked; deleting the user clears it.
    ownerId: uuid("owner_id").references(() => users.id, {
      name: "environments_owner_id_users_id_fk",
      onDelete: "set null",
    }),
    // Where the deployed app opens in a browser (absolute http/https URL).
    url: text("url"),
    // The app this environment deploys. Null until one is assigned (e.g. an
    // environment with no deploy targets yet). restrict: an app in use by an
    // environment can't be deleted.
    appId: uuid("app_id").references(() => apps.id, {
      name: "environments_app_id_apps_id_fk",
      onDelete: "restrict",
    }),
    // Whether the Panel renders this environment's .env on every deploy. False
    // keeps the server-side file hand-managed (only the tag line changes).
    envFileManaged: boolean("env_file_managed").notNull().default(false),
    // Host port the environment's entry point listens on. Null until chosen.
    entryPort: integer("entry_port"),
  },
  (t) => [
    check(
      "environments_entry_port_range",
      sql`${t.entryPort} between 1 and 65535`
    ),
    // Every project page lists its environments; index the parent FK.
    index("environments_project_idx").on(t.projectId),
    // FK index: environments of an app, and the onDelete:restrict check.
    index("environments_app_idx").on(t.appId),
    // FK index: `on delete set null` scans by owner when a user is deleted.
    index("environments_owner_idx").on(t.ownerId),
    // Environment names are unique within a project (so "Dev"/"Release"/"QA-Budi"
    // can't collide under one project, while different projects may reuse them).
    uniqueIndex("environments_project_name_idx").on(t.projectId, t.name),
    // The (key, slug) pair must resolve to exactly one environment for the
    // readable URL — unique within a project.
    uniqueIndex("environments_project_slug_idx").on(t.projectId, t.slug),
  ]
);

// One deployable unit of an environment (its database, backend, frontend, and
// later worker/cache/gateway). Replaces the old wide triple on `environments`:
// each service carries its own server + service type + name, plus the
// role-specific config only that role uses. An environment owns 1..N of these.
export const environmentServices = pgTable(
  "environment_services",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, {
        name: "environment_services_environment_id_fkey",
        onDelete: "cascade",
      }),
    role: serviceRoleEnum("role").notNull(),
    // The server this service runs on. restrict: a server backing any service
    // can't be deleted out from under it.
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, {
        name: "environment_services_server_id_fkey",
        onDelete: "restrict",
      }),
    serviceType: serviceTypeEnum("service_type").notNull(),
    serviceName: text("service_name").notNull(),

    // --- db-role config (null on non-db services) ---
    dbType: databaseTypeEnum("db_type"),
    dbName: text("db_name"),
    // Admin login for the engines the panel authenticates to over TCP
    // (mssql, mysql). Null falls back to the engine's conventional account —
    // see lib/services#dbAdminUser. Not a secret, so it survives the sanitized
    // client projection. Unused for postgres, which uses trusted local auth.
    dbUser: text("db_user"),
    // Required for mssql and mysql (sqlcmd / the mysql client authenticate with
    // it); unused for postgres which relies on trusted local auth
    // (`-U postgres`) inside the container.
    dbPassword: text("db_password"),
    // Where backup files live. Interpretation depends on serviceType:
    // docker/kubernetes — path inside the container/pod; systemd — path on the
    // host filesystem, writable by the DB's OS user (postgres/mssql/mysql).
    dbBackupPath: text("db_backup_path"),
    // Where the database lives; null on services that predate provisioning.
    dbKind: databaseKindEnum("db_kind"),
    // Set when dbKind is "shared". restrict: a host in use can't be deleted.
    databaseHostId: uuid("database_host_id").references(
      () => databaseHosts.id,
      {
        name: "environment_services_database_host_id_fkey",
        onDelete: "restrict",
      }
    ),
    // The role the app connects as. Not a secret.
    dbRole: text("db_role"),
    // Name of the environment variable that holds the role's password; the
    // value itself is never stored here.
    dbPasswordVariable: text("db_password_variable"),

    // --- backend-role config (null on non-backend services) ---
    // URL of the environment's clock resource (e.g. `https://api.example.com/v1/clock`).
    // When set, the time-mocking feature talks to this REST API per
    // docs/time-mocking-api.md; unset falls back to the legacy `date -s` path.
    mockTimeApiUrl: text("mock_time_api_url"),
    // Optional API key sent as the `X-Api-Key` header on mock-time requests.
    mockTimeApiKey: text("mock_time_api_key"),
  },
  (t) => [
    // Exactly one service per role today (getServiceConfig resolves by role).
    // Also serves environment_id-only lookups via the leading column. When
    // multi-instance-per-role is needed, drop this and add a per-service slug.
    uniqueIndex("environment_services_env_role_idx").on(
      t.environmentId,
      t.role
    ),
    // Server-usage lookups + the onDelete:restrict check scan by server_id.
    index("environment_services_server_idx").on(t.serverId),
    // FK index: the onDelete:restrict check scans by database host.
    index("environment_services_database_host_idx").on(t.databaseHostId),
    // A database name is unique within its host.
    uniqueIndex("environment_services_host_db_name_idx")
      .on(t.databaseHostId, t.dbName)
      .where(sql`${t.databaseHostId} is not null`),
  ]
);

// Mailpit connection for one environment: 1:1, row present = integration on.
// A separate table rather than columns on `environments` because whole
// environment rows reach the client in several places (listEnvironments,
// project catalog relations, create/update results); a secret column there
// would leak into RSC payloads.
export const environmentMailpit = pgTable("environment_mailpit", {
  environmentId: uuid("environment_id")
    .primaryKey()
    .references(() => environments.id, {
      name: "environment_mailpit_environment_id_environments_id_fk",
      onDelete: "cascade",
    }),
  // Base URL of the Mailpit UI/API, including any webroot
  // (e.g. `https://mail-qa.example.com/` or `http://10.0.0.5:8025`).
  url: text("url").notNull(),
  // Basic Auth for Mailpit's --ui-auth-file. Null username = no auth.
  username: text("username"),
  // Encrypted at rest via lib/secrets.ts; decrypted only in
  // lib/mailpit/config#loadMailpitConfig.
  password: text("password"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const runStatusEnum = pgEnum("run_status", [
  "started",
  "success",
  "failed",
]);
// What a run did. Null on legacy rows (kind wasn't recorded before); new runs
// set it. `test` runs are QA results recorded against an environment and are the
// only kind currently linked to an issue via `issueId`.
export const runKindEnum = pgEnum("run_kind", [
  "backup",
  "restore",
  "mock_time",
  "test",
  "deploy",
  // Added by the provisioning migration (outside its transaction).
  "provision",
  // Added by the environment teardown migration.
  "teardown",
  // Added by the releases migration.
  "release",
]);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").notNull().default(sql`uuidv7()`),
    // A run acts on ONE deployment (environment).
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, {
        name: "tasks_project_id_projects_id_fkey",
        onDelete: "cascade",
      }),
    // Nullable + set null on user delete: preserve audit history even after the
    // initiating user is removed. UI shows "Unknown" when null.
    userId: uuid("user_id").references(() => users.id, {
      name: "tasks_user_id_users_id_fkey",
      onDelete: "set null",
    }),
    description: text("description").notNull(),
    // Display text for a run without a Panel user: the forge login that pushed
    // the build behind an auto-deploy (max 200 characters), else its head
    // commit's author email, lower-cased (max 320 characters; Bitbucket sends
    // no login), shown as the Panel user with that email when there is one.
    // Never used for authorization; a run with userId shows that user instead.
    triggeredBy: text("triggered_by"),
    status: runStatusEnum("status").notNull().default("started"),
    kind: runKindEnum("kind"),
    // Set on `test` runs to tie a QA result to the issue it verifies. set null:
    // the run's audit record outlives the issue. Null for ops runs.
    issueId: uuid("issue_id").references((): AnyPgColumn => issues.id, {
      name: "runs_issue_id_issues_id_fk",
      onDelete: "set null",
    }),
    // Streaming log appended by worker job steps via appendRunOutput. Lines are
    // separated by `\n`; the SSE endpoint emits the full snapshot on each tick.
    output: text("output").notNull().default(""),
    errorMessage: text("error_message"),
    runAt: timestamp("run_at").notNull(),
    // Null while still running. Set once status transitions to success/failed.
    completedAt: timestamp("completed_at"),
    // Set when someone acknowledges a failed run on Home: it leaves "Needs
    // attention" for everyone. set null on user delete keeps the timestamp
    // (the run stays acknowledged) without pinning the user row.
    acknowledgedAt: timestamp("acknowledged_at"),
    acknowledgedById: uuid("acknowledged_by_id").references(() => users.id, {
      name: "runs_acknowledged_by_id_users_id_fk",
      onDelete: "set null",
    }),
  },
  (t) => [
    // Named explicitly: the table was created as "tasks" and keeps that name.
    primaryKey({ name: "tasks_pkey", columns: [t.id] }),
    // Every run query filters by environmentId and orders by runAt desc
    // (getEnvironmentRuns, getEnvironmentKpis, findLatestByKind, DISTINCT ON).
    index("runs_environment_run_idx").on(t.environmentId, t.runAt.desc()),
    // getActiveRuns filters status='started'.
    index("runs_status_idx").on(t.status),
    // "Test runs for this issue" on the issue detail.
    index("runs_issue_idx").on(t.issueId),
    // Home's "Needs attention" scans unacknowledged failures in a recent
    // window across every environment, newest first.
    index("runs_attention_idx")
      .on(t.runAt.desc())
      .where(sql`${t.status} = 'failed' and ${t.acknowledgedAt} is null`),
  ]
);

export const deployTriggerEnum = pgEnum("deploy_trigger", [
  "auto",
  "manual",
  "rollback",
]);
export const deploymentStatusEnum = pgEnum("deployment_status", [
  "queued",
  "running",
  "success",
  "failed",
  "superseded",
  "held",
]);

export const ciProviderEnum = pgEnum("ci_provider", ["woodpecker"]);
export const forgeKindEnum = pgEnum("forge_kind", [
  "bitbucket",
  "github",
  "gitlab",
  "gitea",
  "forgejo",
]);

// Where a component's pipeline comes from: the repo's own file ("custom") or
// one the Panel generates from the component's build spec ("generated").
export const pipelineModeEnum = pgEnum("pipeline_mode", [
  "custom",
  "generated",
]);

// A CI server and the forge it builds from. Several connections may exist at
// once so components can move between forges one at a time.
export const ciConnections = pgTable("ci_connections", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull().unique("ci_connections_name_unique"),
  provider: ciProviderEnum("provider").notNull(),
  forge: forgeKindEnum("forge").notNull(),
  // CI root, no trailing slash (e.g. https://ci.example.net).
  baseUrl: text("base_url").notNull(),
  // Woodpecker API token. Encrypted at rest via lib/secrets.ts; write-only,
  // never sent to the client.
  apiToken: text("api_token"),
  // Forge account used to commit the generated pipeline file.
  forgeUsername: text("forge_username"),
  // Forge access token. Encrypted at rest via lib/secrets.ts; write-only.
  forgeToken: text("forge_token"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// A product the Panel deploys, e.g. the customer portal. Groups the
// components (backend, frontend, ...) that ship together to an environment.
export const apps = pgTable("apps", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  // Stable slug, e.g. "dplk-customer-portal".
  appKey: text("app_key").notNull().unique("apps_app_key_unique"),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// One deployable unit of an app: one repository built by CI into one Docker
// Compose bundle image.
export const appComponents = pgTable(
  "app_components",
  {
    // Stable slug, e.g. "dplk-customer-portal-backend". Build-notify webhooks
    // and bundle tags address the component by this key.
    componentKey: text("component_key").primaryKey(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, {
        name: "app_components_app_id_apps_id_fk",
        onDelete: "restrict",
      }),
    ciConnectionId: uuid("ci_connection_id")
      .notNull()
      .references(() => ciConnections.id, {
        name: "app_components_ci_connection_id_ci_connections_id_fk",
        onDelete: "restrict",
      }),
    // Repository on the connection's forge, e.g. "dss-consulting/hris".
    repoFullName: text("repo_full_name").notNull(),
    // The CI server's id for the repository; null until it is activated there.
    ciRepoId: text("ci_repo_id"),
    // Image holding the compose bundle, e.g. "dplk-accounting-deploy".
    bundleImage: text("bundle_image").notNull(),
    // Shared secret for the CI build-notify webhook. Encrypted at rest via
    // lib/secrets.ts; never sent to the client.
    notifySecret: text("notify_secret").notNull(),
    // Name of the CI secret that carries the notify secret into the pipeline.
    notifySecretName: text("notify_secret_name")
      .notNull()
      .default("opsdeck_notify"),
    pipelineMode: pipelineModeEnum("pipeline_mode").notNull().default("custom"),
    // Inputs for the generated pipeline; null while the mode is "custom".
    buildSpec: jsonb("build_spec").$type<BuildSpec>(),
    // Per built branch, the last commit of the generated .woodpecker.yaml
    // (sha, or the reason it failed); null until the first attempt.
    pipelineFileCommits: jsonb(
      "pipeline_file_commits"
    ).$type<PipelineFileCommits>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // FK index: components of an app, and the onDelete:restrict check.
    index("app_components_app_idx").on(t.appId),
    // Several components may share a CI repository (one per artifact).
    index("app_components_ci_repo_lookup_idx").on(t.ciConnectionId, t.ciRepoId),
  ]
);

export const variableKindEnum = pgEnum("variable_kind", [
  "plain",
  "secret",
  "generated",
]);

// A variable an app expects in every environment's .env.
export const appVariableTemplates = pgTable(
  "app_variable_templates",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, {
        name: "app_variable_templates_app_id_fkey",
        onDelete: "cascade",
      }),
    name: text("name").notNull(),
    kind: variableKindEnum("kind").notNull(),
    required: boolean("required").notNull().default(false),
    // Plain only. May contain the placeholders {url} and {envSlug}.
    defaultValue: text("default_value"),
    // Generated only: length of the random value, 16-128 (the service
    // defaults it to 32).
    generatedLength: integer("generated_length"),
    // Escrowed variables can never be regenerated or deleted via the UI/API.
    escrow: boolean("escrow").notNull().default(false),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("app_variable_templates_app_name_idx").on(t.appId, t.name),
    check(
      "app_variable_templates_generated_length_check",
      sql`${t.generatedLength} >= 16 AND ${t.generatedLength} <= 128`
    ),
  ]
);

// The value of one variable in one environment.
export const environmentVariables = pgTable(
  "environment_variables",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, {
        name: "environment_variables_environment_id_fkey",
        onDelete: "cascade",
      }),
    name: text("name").notNull(),
    kind: variableKindEnum("kind").notNull(),
    // Encrypted at rest via lib/secrets.ts unless the kind is "plain".
    value: text("value").notNull(),
    escrow: boolean("escrow").notNull().default(false),
    updatedBy: uuid("updated_by").references(() => users.id, {
      name: "environment_variables_updated_by_fkey",
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("environment_variables_environment_name_idx").on(
      t.environmentId,
      t.name
    ),
    // FK index: `on delete set null` scans by updater when a user is deleted.
    index("environment_variables_updated_by_idx").on(t.updatedBy),
  ]
);

// At most one deploy lock per environment; see lib/deploy/lock.ts.
export const environmentDeployLocks = pgTable(
  "environment_deploy_locks",
  {
    environmentId: uuid("environment_id")
      .primaryKey()
      .references(() => environments.id, {
        name: "environment_deploy_locks_environment_id_fkey",
        onDelete: "cascade",
      }),
    lockedBy: uuid("locked_by").references(() => users.id, {
      name: "environment_deploy_locks_locked_by_fkey",
      onDelete: "set null",
    }),
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("environment_deploy_locks_locked_by_idx").on(t.lockedBy),
    index("environment_deploy_locks_expires_at_idx").on(t.expiresAt),
  ]
);

// Ordered steps of an environment's provisioning; see lib/provisioning.
export const provisioningSteps = pgTable(
  "provisioning_steps",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, {
        name: "provisioning_steps_environment_id_fkey",
        onDelete: "cascade",
      }),
    position: integer("position").notNull(),
    kind: provisioningStepKindEnum("kind").notNull(),
    // Non-secret parameters only; secrets come from the environment's
    // variables at run time.
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    status: provisioningStepStatusEnum("status").notNull().default("pending"),
    lastError: text("last_error"),
    // set null: the step outlives the run that last executed it.
    lastRunId: uuid("last_run_id").references(() => runs.id, {
      name: "provisioning_steps_last_run_id_fkey",
      onDelete: "set null",
    }),
    completedAt: timestamp("completed_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("provisioning_steps_environment_position_idx").on(
      t.environmentId,
      t.position
    ),
    // FK index: "on delete set null" scans by run when a run is deleted.
    index("provisioning_steps_last_run_idx").on(t.lastRunId),
  ]
);

export const teardownStepKindEnum = pgEnum("teardown_step_kind", [
  "check_stack",
  "archive_database",
  "stop_stack",
  "archive_deploy_dir",
  "archive_volumes",
  "stack_down",
  "drop_database",
  "remove_tunnel_route",
  "remove_access_app",
  "remove_dns_record",
  "remove_deploy_dir",
  "delete_environment",
]);

export const teardownStepStatusEnum = pgEnum("teardown_step_status", [
  "pending",
  "running",
  "done",
  "failed",
]);

// Ordered steps of an environment's teardown; see lib/teardown. Deleted with
// the environment (the last step deletes the environment row itself).
export const teardownSteps = pgTable(
  "teardown_steps",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, {
        name: "teardown_steps_environment_id_fkey",
        onDelete: "cascade",
      }),
    position: integer("position").notNull(),
    kind: teardownStepKindEnum("kind").notNull(),
    // Non-secret parameters only.
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    status: teardownStepStatusEnum("status").notNull().default("pending"),
    // Stable error code of the last failure; null otherwise.
    lastError: text("last_error"),
    // set null: the step outlives the run that last executed it.
    lastRunId: uuid("last_run_id").references(() => runs.id, {
      name: "teardown_steps_last_run_id_fkey",
      onDelete: "set null",
    }),
    completedAt: timestamp("completed_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("teardown_steps_environment_position_idx").on(
      t.environmentId,
      t.position
    ),
    // FK index: "on delete set null" scans by run when a run is deleted.
    index("teardown_steps_last_run_idx").on(t.lastRunId),
  ]
);

export const environmentArchiveLocationEnum = pgEnum(
  "environment_archive_location",
  ["local", "s3"]
);

export type EnvironmentArchiveFile = { name: string; size: number };

// What a teardown kept of a deleted environment (database dump, deploy dir
// tarball). Names are snapshots and environmentId has no foreign key, so the
// row survives the environment's delete. completedAt stays null until the
// environment row is gone; the open row is how a retry finds its archive.
export const environmentArchives = pgTable(
  "environment_archives",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    environmentId: uuid("environment_id"),
    projectName: text("project_name").notNull(),
    environmentName: text("environment_name").notNull(),
    environmentSlug: text("environment_slug").notNull(),
    deletedById: uuid("deleted_by").references(() => users.id, {
      name: "environment_archives_deleted_by_fkey",
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    location: environmentArchiveLocationEnum("location").notNull(),
    // The S3 connection an `s3` archive was written to (null for `local`),
    // so download and prune read the bucket it is in, not today's backup
    // destination. set null: an `s3` archive without one is unreachable,
    // and the prune keeps its row.
    s3ConnectionId: uuid("s3_connection_id").references(
      () => s3Connections.id,
      {
        name: "environment_archives_s3_connection_id_fkey",
        onDelete: "set null",
      }
    ),
    keyPrefix: text("key_prefix").notNull(),
    files: jsonb("files")
      .$type<EnvironmentArchiveFile[]>()
      .notNull()
      .default([]),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    index("environment_archives_environment_idx").on(t.environmentId),
    // At most one open archive per environment: the teardown's.
    uniqueIndex("environment_archives_open_idx")
      .on(t.environmentId)
      .where(sql`${t.completedAt} IS NULL`),
    index("environment_archives_expires_at_idx").on(t.expiresAt),
    index("environment_archives_deleted_by_idx").on(t.deletedById),
    // FK index: "on delete set null" scans by connection.
    index("environment_archives_s3_connection_idx").on(t.s3ConnectionId),
  ]
);

export const deployTargetKindEnum = pgEnum("deploy_target_kind", [
  "compose",
  "jar",
  "static",
]);

// Where a component deploys to: one target per (environment, component).
export const deployTargets = pgTable(
  "deploy_targets",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, {
        name: "deploy_targets_environment_id_environments_id_fk",
        onDelete: "cascade",
      }),
    componentKey: text("component_key")
      .notNull()
      .references(() => appComponents.componentKey, {
        name: "deploy_targets_component_key_app_components_component_key_fk",
        onDelete: "restrict",
      }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, {
        name: "deploy_targets_server_id_servers_id_fk",
        onDelete: "restrict",
      }),
    sourceBranch: text("source_branch").notNull(),
    autoDeploy: boolean("auto_deploy").notNull().default(false),
    kind: deployTargetKindEnum("kind").notNull().default("compose"),
    // Jar kind only: file name the jar gets on deploy, and the systemd unit
    // restarted afterwards.
    jarName: text("jar_name"),
    systemdUnit: text("systemd_unit"),
    deployDir: text("deploy_dir").notNull(),
    services: text("services").array().notNull(),
    tagVariable: text("tag_variable").notNull().default("IMAGE_TAG"),
    preStartCommand: text("pre_start_command"),
    healthUrl: text("health_url"),
    healthTimeoutSeconds: integer("health_timeout_seconds")
      .notNull()
      .default(180),
    backupBeforeDeploy: boolean("backup_before_deploy")
      .notNull()
      .default(false),
    // Set when the target's branch had no build at provisioning time: the
    // next build of that branch is deployed once, then the flag is cleared.
    deployNextBuild: boolean("deploy_next_build").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("deploy_targets_environment_component_idx").on(
      t.environmentId,
      t.componentKey
    ),
    index("deploy_targets_component_idx").on(t.componentKey),
    check(
      "deploy_targets_kind_fields_check",
      sql`(${t.kind} = 'jar' and ${t.jarName} is not null and ${t.systemdUnit} is not null) or (${t.kind} <> 'jar' and ${t.jarName} is null and ${t.systemdUnit} is null)`
    ),
  ]
);

// A CI-built image tag reported by the build-notify webhook.
export const builds = pgTable(
  "builds",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    componentKey: text("component_key")
      .notNull()
      .references(() => appComponents.componentKey, {
        name: "builds_component_key_app_components_component_key_fk",
        onDelete: "cascade",
      }),
    branch: text("branch").notNull(),
    tag: text("tag").notNull(),
    commitSha: text("commit_sha").notNull(),
    pipelineUrl: text("pipeline_url"),
    // Best-effort from the CI provider at notify time (null when unavailable):
    // the forge login that pushed (or merged), the head commit's author email
    // and its message (max 500 characters). Display only.
    pushedBy: text("pushed_by"),
    commitAuthorEmail: text("commit_author_email"),
    commitMessage: text("commit_message"),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("builds_component_tag_idx").on(t.componentKey, t.tag),
    index("builds_component_branch_received_idx").on(
      t.componentKey,
      t.branch,
      t.receivedAt.desc().nullsFirst()
    ),
  ]
);

// One attempt to roll a tag out to a target; backed by a `deploy` run for logs.
export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    targetId: uuid("target_id")
      .notNull()
      .references(() => deployTargets.id, {
        name: "deployments_target_id_deploy_targets_id_fk",
        onDelete: "cascade",
      }),
    // Denormalised from the target so the partial unique index below can
    // enforce one running deploy per environment.
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, {
        name: "deployments_environment_id_environments_id_fk",
        onDelete: "cascade",
      }),
    // Null while `held`: the run is created when the deployment is queued
    // (at request time, or when the deploy lock is released).
    runId: uuid("run_id").references(() => runs.id, {
      name: "deployments_run_id_runs_id_fk",
      onDelete: "cascade",
    }),
    tag: text("tag").notNull(),
    trigger: deployTriggerEnum("trigger").notNull(),
    status: deploymentStatusEnum("status").notNull().default("queued"),
    buildId: uuid("build_id").references(() => builds.id, {
      name: "deployments_build_id_builds_id_fk",
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    // Bumped by the worker every minute while the deploy runs; the stale sweep
    // fails running deployments whose heartbeat stopped (dead worker).
    heartbeatAt: timestamp("heartbeat_at"),
    // Set just before the deploy script is sent to the server. From then on
    // the server may run this tag, even when the deployment later fails.
    scriptStartedAt: timestamp("script_started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    index("deployments_target_created_idx").on(
      t.targetId,
      t.createdAt.desc().nullsFirst()
    ),
    // DB-level guarantee of at most one running deploy per environment.
    uniqueIndex("deployments_one_running_per_env_idx")
      .on(t.environmentId)
      .where(sql`${t.status} = 'running'`),
  ]
);

// Per-user, per-environment recency. Drives the header switcher's order:
// most-recently-opened first (MRU). One row per (user, environment); upserted on
// each open by recordEnvironmentAccess. The thing opened is a deployment
// (`environments`), so the FK is named accordingly.
export const environmentAccess = pgTable(
  "environment_access",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, {
        name: "project_access_user_id_users_id_fkey",
        onDelete: "cascade",
      }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, {
        name: "project_access_project_id_projects_id_fkey",
        onDelete: "cascade",
      }),
    lastAccessedAt: timestamp("last_accessed_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "project_access_pkey",
      columns: [t.userId, t.environmentId],
    }),
    // listEnvironments orders one user's rows by lastAccessedAt desc; a covering
    // index on (userId, lastAccessedAt) serves that without a sort.
    index("environment_access_user_recency_idx").on(
      t.userId,
      t.lastAccessedAt.desc()
    ),
  ]
);

// =========================
// Per-project membership (RBAC)
// =========================

// Legacy: the type of project_members.role below, dropped with it in the next
// release.
export const projectRoleEnum = pgEnum("project_role", [
  "viewer",
  "qa",
  "engineer",
]);

// A row lists a person on a project, and makes the project visible to an
// engineer or QA (admin, infra and observer see every project anyway). What
// they may do there comes from their global role (users.role).
export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, {
        name: "project_members_project_id_projects_id_fk",
        onDelete: "cascade",
      }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, {
        name: "project_members_user_id_users_id_fk",
        onDelete: "cascade",
      }),
    // Legacy: the previous release still reads and writes it (update.sh can
    // roll back to it on this schema); this code never reads or writes it, so
    // inserts take the default, 'viewer', so that after a rollback a membership
    // added by this release can only lower rights, never raise them. Dropped in
    // the next release.
    role: projectRoleEnum("role").notNull().default("viewer"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "project_members_project_id_user_id_pk",
      columns: [t.projectId, t.userId],
    }),
    // "Which projects can this user reach" — the membership lookup on every
    // capability check that carries a project/environment scope.
    index("project_members_user_idx").on(t.userId),
  ]
);

// A row says the project builds and deploys this app: one of its Sources.
// Expand-only: the previous release never reads it, so environments created
// during a rollback window have no row here, and reads take the union with
// the apps of the project's environments.
export const projectApps = pgTable(
  "project_apps",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, {
        name: "project_apps_project_id_projects_id_fk",
        onDelete: "cascade",
      }),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, {
        name: "project_apps_app_id_apps_id_fk",
        onDelete: "restrict",
      }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "project_apps_project_id_app_id_pk",
      columns: [t.projectId, t.appId],
    }),
    // FK index: `on delete restrict` scans by app when an app is deleted.
    index("project_apps_app_idx").on(t.appId),
  ]
);

// A row is the project's default branch for one component: the branch a new
// environment's target of that component starts on. Expand-only: the previous
// release never reads it. The service, not a composite FK, checks that the
// component's app is one of the project's sources (app_components has no
// (app_id, component_key) key to reference).
export const projectComponentBranches = pgTable(
  "project_component_branches",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, {
        name: "project_component_branches_project_id_projects_id_fk",
        onDelete: "cascade",
      }),
    // Named by hand: drizzle's default FK name would pass the 63-byte limit.
    componentKey: text("component_key")
      .notNull()
      .references(() => appComponents.componentKey, {
        name: "project_component_branches_component_key_fk",
        onDelete: "restrict",
      }),
    branch: text("branch").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => users.id, {
      name: "project_component_branches_updated_by_users_id_fk",
      onDelete: "set null",
    }),
  },
  (t) => [
    primaryKey({
      name: "project_component_branches_project_id_component_key_pk",
      columns: [t.projectId, t.componentKey],
    }),
    // FK index: `on delete restrict` scans by component when one is deleted.
    index("project_component_branches_component_idx").on(t.componentKey),
    // FK index: `on delete set null` scans by updater when a user is deleted.
    index("project_component_branches_updated_by_idx").on(t.updatedBy),
  ]
);

// =========================
// Issue tracker (per project)
// =========================

// A planning bucket issues are grouped into (a release, a sprint goal, a
// deliverable). Belongs to the LOGICAL project; `dueAt`/`closedAt` are optional
// so a milestone can be open-ended or archived. Distinct from an environment's
// `kind=release` — that's a deployment purpose, this is a work target.
export const milestones = pgTable(
  "milestones",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, {
        name: "milestones_project_id_projects_id_fk",
        onDelete: "cascade",
      }),
    name: text("name").notNull(),
    description: text("description"),
    dueAt: timestamp("due_at"),
    // Null = open. Set when the milestone is completed/archived.
    closedAt: timestamp("closed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("milestones_project_idx").on(t.projectId)]
);

// Issues belong to the LOGICAL project, not a deployment, so a bug tracked as
// CMEM-42 is stable no matter which environment it was seen in. `number` is a
// per-project sequential counter (assigned as max(number)+1 within a
// transaction in the create action) that pairs with projects.key to form the
// human key. `environmentId` optionally pins which deployment it was found in.
export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, {
        name: "issues_project_id_projects_id_fk",
        onDelete: "cascade",
      }),
    // Per-project sequential number -> `${project.key}-${number}` (e.g. CMEM-42).
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: issueStatusEnum("status").notNull().default("open"),
    type: issueTypeEnum("type").notNull().default("task"),
    priority: issuePriorityEnum("priority").notNull().default("medium"),
    // Story points / rough size. Null = unestimated. Free integer, not a scale
    // enum — teams pick their own convention (points, hours, t-shirt→number).
    estimate: integer("estimate"),
    // Parent issue for epic → story → subtask nesting. Self-FK; set null so
    // deleting a parent re-parents children to top level instead of cascading.
    parentId: uuid("parent_id").references((): AnyPgColumn => issues.id, {
      name: "issues_parent_id_issues_id_fk",
      onDelete: "set null",
    }),
    // Planning bucket. set null: the issue outlives a milestone that's deleted.
    milestoneId: uuid("milestone_id").references(() => milestones.id, {
      name: "issues_milestone_id_milestones_id_fk",
      onDelete: "set null",
    }),
    // Which deployment the issue was observed in. set null: the issue outlives
    // any single environment. Null = not tied to a specific one.
    environmentId: uuid("environment_id").references(() => environments.id, {
      name: "issues_environment_id_environments_id_fk",
      onDelete: "set null",
    }),
    createdById: uuid("created_by_id").references(() => users.id, {
      name: "issues_created_by_id_users_id_fk",
      onDelete: "set null",
    }),
    assigneeId: uuid("assignee_id").references(() => users.id, {
      name: "issues_assignee_id_users_id_fk",
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),

    // --- Jira mirror (null on issues that were never linked) ---
    // Jira's own numeric issue id. THIS is the join key, not `jiraKey`: a key
    // changes when an issue is moved between Jira projects, the id never does.
    jiraIssueId: text("jira_issue_id"),
    // Display key ("CMEM-42" in Jira's numbering, which is unrelated to ours).
    jiraKey: text("jira_key"),
    // The remote `fields.updated` of the last revision we applied. Guards
    // replay (webhook re-delivery, sweep overlap) and recognizes the echo of
    // our own push, both as `remote.updated <= jiraUpdatedAt -> skip`.
    jiraUpdatedAt: timestamp("jira_updated_at"),
    jiraSyncedAt: timestamp("jira_synced_at"),
  },
  (t) => [
    // The human issue key CMEM-42 must resolve to exactly one row.
    uniqueIndex("issues_project_number_idx").on(t.projectId, t.number),
    // One OpsDeck issue per remote issue. Partial so the (many) unlinked rows
    // don't collide on NULL and don't sit in the index.
    uniqueIndex("issues_jira_issue_id_idx")
      .on(t.jiraIssueId)
      .where(sql`${t.jiraIssueId} is not null`),
    // Board/list view filters by project then status.
    index("issues_project_status_idx").on(t.projectId, t.status),
    // Default order of the cross-project list (newest activity first). Paging
    // without it means a full sort of the table on every page.
    index("issues_updated_at_idx").on(t.updatedAt.desc().nullsFirst()),
    // Cross-project filters: "assigned to me" and the status dropdown.
    index("issues_assignee_idx").on(t.assigneeId),
    index("issues_status_idx").on(t.status),
    // Children-of-parent lookup for the subtask tree.
    index("issues_parent_idx").on(t.parentId),
    // Milestone board / "issues in this milestone".
    index("issues_milestone_idx").on(t.milestoneId),
  ]
);

// Threaded discussion on an issue. Author is set null on user delete so the
// comment survives (shown as "Unknown"); the row is deleted with its issue.
export const issueComments = pgTable(
  "issue_comments",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, {
        onDelete: "cascade",
      }),
    authorId: uuid("author_id").references(() => users.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Remote comment id, when this comment mirrors (or was pushed to) Jira.
    jiraCommentId: text("jira_comment_id"),
  },
  (t) => [
    // The detail page lists a thread oldest-first.
    index("issue_comments_issue_idx").on(t.issueId, t.createdAt),
    // Comment sync is an upsert keyed on the remote id. Partial for the same
    // reason as issues_jira_issue_id_idx.
    uniqueIndex("issue_comments_jira_id_idx")
      .on(t.jiraCommentId)
      .where(sql`${t.jiraCommentId} is not null`),
  ]
);

// File/image attachments on an issue. Bytes live in object storage (same bucket
// as KB assets); this row is metadata + the stable id the download route serves.
// Unlike KB attachments (whose markdown body is the source of truth), an issue
// has no link-graph, so a direct `issueId` FK owns the attachment and cascades
// on issue delete. `filename` preserves the uploader's original name for display.
export const issueAttachments = pgTable(
  "issue_attachments",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, {
        name: "issue_attachments_issue_id_issues_id_fk",
        onDelete: "cascade",
      }),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedById: uuid("uploaded_by_id").references(() => users.id, {
      name: "issue_attachments_uploaded_by_id_users_id_fk",
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("issue_attachments_issue_idx").on(t.issueId)]
);

// Workspace-wide issue labels (shared across all projects so the global issue
// view can filter by one taxonomy). `color` is a hex string rendered as a chip.
export const labels = pgTable("labels", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("#64748b"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Many-to-many join between issues and labels.
export const issueLabels = pgTable(
  "issue_labels",
  {
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, {
        onDelete: "cascade",
      }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, {
        onDelete: "cascade",
      }),
  },
  (t) => [
    primaryKey({
      columns: [t.issueId, t.labelId],
    }),
    // "Which issues have label X" for the label filter.
    index("issue_labels_label_idx").on(t.labelId),
  ]
);

// Per-user saved filter presets for the global issues view. `params` is the
// filter query (status/project/label/mine/view) as a flat string map so it maps
// straight onto the URL query — views are just named URL states.
export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
      }),
    name: text("name").notNull(),
    params: jsonb("params").$type<Record<string, string>>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("saved_views_user_idx").on(t.userId, t.createdAt)]
);

// =========================
// Activity / audit stream
// =========================

// One append-only org-wide event feed. `action` is a dotted verb key
// (e.g. "issue.created") the reader renders via an i18n template; `data` holds
// that template's params, denormalized at write time so the feed reads without
// joins even after the referenced row changes or is deleted. Add event types,
// not new subsystems — this stream feeds the Activity page (and, later,
// compliance export). `actorId` set null keeps history after a user is removed.
export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    actorId: uuid("actor_id").references(() => users.id, {
      name: "activity_log_actor_id_users_id_fk",
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    // Coarse tag for filtering ("issue" | "member" | "milestone" | "test"…).
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    data: jsonb("data").$type<Record<string, string | number>>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("activity_created_idx").on(t.createdAt.desc().nullsFirst())]
);

// =========================
// Notifications
// =========================

export const notificationTypeEnum = pgEnum("notification_type", [
  "issue_assigned",
  "run_failed",
  "issue_mention",
  "jira_push_failed",
]);

// Per-user inbox items. Text is NOT stored — only a `type` + structured `data`
// so the message renders in the recipient's own locale at read time (their
// locale isn't known when the event fires). `href` is the jump target.
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
      }),
    type: notificationTypeEnum("type").notNull(),
    // Params for the i18n template keyed by `type` (e.g. { key, number, title }).
    data: jsonb("data").$type<Record<string, string | number>>().notNull(),
    href: text("href"),
    // Null = unread. Set when the user opens/acknowledges it.
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // The bell lists one user's notifications newest-first and counts unread.
    index("notifications_user_created_idx").on(t.userId, t.createdAt.desc()),
  ]
);

// =========================
// Auth (better-auth) tables
// =========================

// `role`, `banned`, `banReason`, `banExpires` are managed by the better-auth
// admin plugin (lib/auth.ts). `role` is the global job role (lib/permissions
// ORG_ROLES); it defaults to "qa", and the bootstrap user created in
// `createInitialUser` is promoted to "admin".
export type AvatarSource = "upload" | "microsoft" | "removed";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    role: text("role").notNull().default("qa"),
    banned: boolean("banned").notNull().default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires"),
    // Atlassian account id, so a Jira assignee resolves to an OpsDeck user. Seeded
    // by email match on first sync; an admin can correct it. Not unique — a stale
    // duplicate must not be able to block a user row from saving.
    jiraAccountId: text("jira_account_id"),
    // --- Profile (self-managed; see actions/profile.ts) ---
    title: text("title"),
    bio: text("bio"),
    // IANA zone; null = APP_TIMEZONE (lib/timezone effectiveTimeZone).
    timezone: text("timezone"),
    workingHours: jsonb("working_hours").$type<WorkingHours>(),
    // Status expiry is enforced on read (lib/user-display activeStatus).
    statusEmoji: text("status_emoji"),
    statusText: text("status_text"),
    statusExpiresAt: timestamp("status_expires_at"),
    // Where `image` came from. 'removed' blocks the Microsoft re-import.
    avatarSource: text("avatar_source").$type<AvatarSource>(),
    // lib/accents.ts ACCENTS; null = the brand default (effectiveAccent).
    accentColor: text("accent_color").$type<AccentColor>(),
    // lib/motifs.ts: 'none' or a motif slug; null = daily rotation
    // (effectiveMotifPreference).
    motif: text("motif").$type<Exclude<MotifPreference, "daily">>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Mentions resolve by exact @name, so active names must not collide.
    uniqueIndex("users_active_name_lower_idx")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.banned} = false`),
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // Set by the admin plugin during impersonation; null on normal sessions.
    impersonatedBy: uuid("impersonated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // better-auth resolves the session by userId on every authenticated request.
    index("sessions_user_idx").on(t.userId),
  ]
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // accountId/providerId are external identifiers (provider's user id, OAuth
    // provider name) — keep as text since they're not always UUID-shaped.
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // better-auth looks up the credential account by userId on sign-in / linking.
    index("accounts_user_idx").on(t.userId),
  ]
);

export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// WebAuthn credentials, owned by the better-auth passkey plugin. One row per
// registered authenticator, so a user normally has several (laptop biometrics,
// phone, a hardware key). Field names must match the plugin's model exactly —
// the drizzle adapter maps `model: "passkey"` to this table by key, not by
// column name, so `credentialID` cannot be renamed to `credentialId`.
export const passkeys = pgTable(
  "passkeys",
  {
    id: uuid("id").primaryKey(),
    // User-facing label. The client sends one on registration; when it doesn't,
    // the plugin falls back to the authenticator model resolved from `aaguid`.
    name: text("name"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, {
        name: "passkeys_user_id_fkey",
        onDelete: "cascade",
      }),
    // Base64url values from the authenticator, not UUID-shaped.
    credentialID: text("credential_id").notNull(),
    publicKey: text("public_key").notNull(),
    // Signature counter for clone detection; bumped on every authentication.
    counter: integer("counter").notNull().default(0),
    // "singleDevice" | "multiDevice" — whether the credential syncs.
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull().default(false),
    // Comma-joined WebAuthn transport hints, e.g. "internal,hybrid".
    transports: text("transports"),
    // Authenticator model id, used only to label the passkey in the UI. Apple
    // and other privacy-preserving platforms report an all-zero value.
    aaguid: text("aaguid"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Listing a user's passkeys, and building `excludeCredentials` on register.
    index("passkeys_user_idx").on(t.userId),
    // Sign-in resolves the credential the browser returned, before any user is
    // known. Unique because a credential id identifies exactly one credential.
    uniqueIndex("passkeys_credential_id_idx").on(t.credentialID),
  ]
);

// =========================
// Custom: invitations
// =========================

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    email: text("email").notNull(),
    name: text("name").notNull(),
    // The global job role the user gets upon accepting the invitation, one of
    // lib/permissions ORG_ROLES (validated in server/services/users.ts).
    role: text("role").notNull().default("qa"),
    // token is a separate random secret used in the invite URL — keep as text.
    token: text("token").notNull().unique(),
    invitedById: uuid("invited_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // inviteUser looks up existing invites by email before issuing a new one.
    index("invitations_email_idx").on(t.email),
  ]
);

// =========================
// Custom: S3 storage connections
// =========================

// User-configured S3-compatible endpoints browsed by the storage explorer.
// Distinct from the single env-configured bucket in lib/storage.ts (KB
// attachments): those creds are ops-owned infra config, these are arbitrary
// targets an admin points the explorer at (Garage, real S3, SeaweedFS, Ceph…).
// Managing them is admin-only; `secretKey` never crosses the server/client
// boundary (see SafeS3Connection).
export const s3Connections = pgTable("s3_connections", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),
  endpoint: text("endpoint").notNull(),
  region: text("region").notNull().default("us-east-1"),
  bucket: text("bucket").notNull(),
  accessKeyId: text("access_key_id").notNull(),
  // Secret credential. Stored like servers.password (plaintext today; see the
  // at-rest encryption TODO in docs) and stripped before reaching the client.
  secretKey: text("secret_key").notNull(),
  // Path-style addressing (bucket in the URL path, not a virtual-host DNS
  // prefix). Required by Garage and most self-hosted S3; real AWS S3 tolerates
  // it too, so it defaults on.
  forcePathStyle: boolean("force_path_style").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// =========================
// Jira integration
// =========================

// A Jira site OpsDeck can talk to, managed by admins like `servers` and
// `s3Connections`. Workspace-level rather than per-project because one site
// hosts many Jira projects — a project points at a connection, it doesn't own
// credentials.
export const jiraConnections = pgTable("jira_connections", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),
  // Site root, no trailing slash (e.g. https://acme.atlassian.net).
  baseUrl: text("base_url").notNull(),
  flavor: jiraFlavorEnum("flavor").notNull().default("cloud"),
  // Cloud: the account the API token belongs to (Basic auth username).
  // Data Center: null — a PAT is a Bearer token with no paired username.
  email: text("email"),
  // Encrypted at rest via lib/secrets.ts, stripped before any row reaches the
  // client (see SafeJiraConnection).
  apiToken: text("api_token").notNull(),
  // Random token embedded in the webhook URL path. Jira Cloud's system webhooks
  // cannot sign a request body, so an unguessable path compared in constant
  // time is the available guard — and the receiver re-fetches the issue from
  // the API rather than trusting the delivered payload.
  webhookSecret: text("webhook_secret").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Binds one OpsDeck project to one Jira project. Primary-keyed on `projectId`:
// a project mirrors at most one Jira project, which keeps "where does this
// issue come from" a single lookup with no ambiguity.
export const jiraProjectLinks = pgTable(
  "jira_project_links",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id, {
        name: "jira_project_links_project_id_fkey",
        onDelete: "cascade",
      }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => jiraConnections.id, {
        name: "jira_project_links_connection_id_fkey",
        onDelete: "cascade",
      }),
    // Remote project key ("CMEM"). Unrelated to projects.key — a project may
    // mirror a Jira project with a different prefix.
    jiraProjectKey: text("jira_project_key").notNull(),
    // Extra JQL AND-ed onto every sweep (e.g. `labels = opsdeck`), so a team can
    // mirror a slice of a large Jira project instead of all of it.
    jqlFilter: text("jql_filter"),
    enabled: boolean("enabled").notNull().default(true),
    // Off by default: pull-only. On = the small allowlist of fields in
    // lib/jira/push.ts is written back when an OpsDeck user edits an issue.
    pushEnabled: boolean("push_enabled").notNull().default(false),
    // Per-link overrides layered on the defaults in lib/jira/mapping.ts. Jira
    // workflows differ per project, but not enough to justify a mapping table
    // and an editor — a jsonb patch keeps it one column.
    mappingOverrides: jsonb("mapping_overrides").$type<JiraMappingOverrides>(),
    // High-water mark: the greatest remote `updated` we have applied. The next
    // sweep queries `updated >= lastSyncAt - overlap` (see lib/jira/sync.ts).
    lastSyncAt: timestamp("last_sync_at"),
    lastSyncStatus: jiraSyncStatusEnum("last_sync_status"),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Two OpsDeck projects mirroring the same Jira project would fight over the
    // same remote issues (which are globally unique by `jiraIssueId`).
    uniqueIndex("jira_links_connection_key_idx").on(
      t.connectionId,
      t.jiraProjectKey
    ),
    // The sweep scheduler walks every enabled link.
    index("jira_links_connection_idx").on(t.connectionId),
  ]
);

// =========================
// Cloudflare Tunnel subdomains
// =========================

// A Cloudflare DNS zone the panel may publish hostnames in, managed by admins
// like `servers`, `s3Connections`, and `jiraConnections`.
//
// The credential is held per zone rather than per tunnel because that is the
// shape of the authority it grants: a `Zone:DNS:Edit` token covers every record
// in one zone, whichever tunnel a hostname ends up on. Copying it onto each
// tunnel row would duplicate one secret and make rotation an N-row edit.
export const cloudflareZones = pgTable("cloudflare_zones", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  // The apex domain, e.g. "example.net". Hostnames are formed as
  // `<label>.<name>`, and the panel refuses anything that isn't under a zone
  // registered here.
  name: text("name").notNull().unique("cloudflare_zones_name_unique"),
  // Cloudflare's own zone identifier, taken from the dashboard overview.
  zoneId: text("zone_id").notNull(),
  // API token, encrypted at rest via lib/secrets.ts and stripped before any row
  // reaches the client (see SafeCloudflareZone).
  //
  // Scope it to `Zone:DNS:Edit` on THIS ZONE ONLY. That is everything the panel
  // does with it, and it deliberately excludes creating or deleting tunnels —
  // which is why tunnel creation is not a feature here and stays a manual,
  // audited step performed with the account-wide origin certificate.
  apiToken: text("api_token"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// A locally-managed `cloudflared` tunnel the panel can edit the ingress of.
//
// Note what is NOT here: the routes. The tunnel's `config.yml` on the server is
// the source of truth for its ingress table, and this row only records where to
// find it. Mirroring routes into Postgres would create a second source of truth
// for the same fact — and a stale route table is how orphaned hostnames and
// silent 1016s happen. Routes are read by parsing the file (lib/tunnels/remote).
export const tunnels = pgTable(
  "tunnels",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // restrict: a zone still publishing hostnames can't be deleted out from
    // under the tunnels that depend on its credential.
    zoneId: uuid("zone_id")
      .notNull()
      .references(() => cloudflareZones.id, {
        name: "tunnels_zone_id_cloudflare_zones_id_fk",
        onDelete: "restrict",
      }),
    // The host the tunnel's stack and container live on. The panel reaches it
    // with this server's existing SSH credentials.
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, {
        name: "tunnels_server_id_servers_id_fk",
        onDelete: "restrict",
      }),
    // Human label, matching what `cloudflared tunnel list` shows (e.g.
    // "dss-apps-136"). Display only — never used to address the tunnel, because
    // resolving a name needs the origin certificate that isn't kept on the host.
    name: text("name").notNull(),
    // The tunnel's UUID. This is what a hostname's CNAME points at, as
    // `<tunnelId>.cfargotunnel.com`, and it is the `tunnel:` key of config.yml.
    tunnelId: text("tunnel_id").notNull(),
    // Directory holding the stack's compose file; also the working directory
    // the apply step runs `docker compose up -d` in.
    stackDir: text("stack_dir").notNull(),
    // Config location relative to `stackDir`. Kept configurable rather than
    // assumed: it is a bind-mount source the stack author chose.
    configPath: text("config_path").notNull().default("cloudflared/config.yml"),
    // The running container, used for the post-apply health check and for
    // reading which Docker networks the tunnel can currently reach.
    containerName: text("container_name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // One row per tunnel per host. Two rows for the same tunnel would let two
    // stack directories claim the same ingress table.
    uniqueIndex("tunnels_server_tunnel_idx").on(t.serverId, t.tunnelId),
    // The zone page lists its tunnels; the delete-guard scans by zone.
    index("tunnels_zone_idx").on(t.zoneId),
    index("tunnels_server_idx").on(t.serverId),
  ]
);

// The Cloudflare account the Panel manages remotely-managed tunnels, Access
// apps and DNS records in. One token covers all of it (Tunnel: Edit, Access
// Apps and Policies: Edit, Access IdPs: Read, DNS: Edit on the zone), so it is
// held once per account. Encrypted at rest and never sent to the client.
export const cloudflareAccounts = pgTable("cloudflare_accounts", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  accountId: text("account_id").notNull().unique(),
  name: text("name").notNull(),
  apiToken: text("api_token").notNull(),
  // The identity provider the Access apps the Panel creates allow.
  accessIdpId: text("access_idp_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// A remotely-managed tunnel running on a server; its ingress is edited through
// the Cloudflare API. One per server.
export const remoteTunnels = pgTable(
  "remote_tunnels",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => cloudflareAccounts.id, {
        name: "remote_tunnels_account_id_fkey",
        onDelete: "restrict",
      }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, {
        name: "remote_tunnels_server_id_fkey",
        onDelete: "restrict",
      }),
    tunnelId: text("tunnel_id").notNull(),
    name: text("name").notNull(),
    // Where cloudflared reaches the environment's entry port from.
    originHost: text("origin_host").notNull().default("localhost"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("remote_tunnels_account_tunnel_idx").on(
      t.accountId,
      t.tunnelId
    ),
    // One remote tunnel per server; also serves the server FK restrict check.
    uniqueIndex("remote_tunnels_server_idx").on(t.serverId),
  ]
);

// The public domain of an environment (at most one, hence the environment as
// key). access_app_id and dns_record_id are written by the provisioning steps.
export const environmentDomains = pgTable(
  "environment_domains",
  {
    environmentId: uuid("environment_id")
      .primaryKey()
      .references(() => environments.id, {
        name: "environment_domains_environment_id_fkey",
        onDelete: "cascade",
      }),
    kind: domainKindEnum("kind").notNull(),
    hostname: text("hostname").notNull().unique(),
    // Tunnel domains only (see the check below).
    zoneId: uuid("zone_id").references(() => cloudflareZones.id, {
      name: "environment_domains_zone_id_fkey",
      onDelete: "restrict",
    }),
    remoteTunnelId: uuid("remote_tunnel_id").references(
      () => remoteTunnels.id,
      {
        name: "environment_domains_remote_tunnel_id_fkey",
        onDelete: "restrict",
      }
    ),
    accessPolicyId: text("access_policy_id"),
    accessAppId: text("access_app_id"),
    dnsRecordId: text("dns_record_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "environment_domains_tunnel_refs",
      sql`${t.kind} <> 'tunnel' OR (${t.zoneId} IS NOT NULL AND ${t.remoteTunnelId} IS NOT NULL)`
    ),
    index("environment_domains_zone_idx").on(t.zoneId),
    index("environment_domains_remote_tunnel_idx").on(t.remoteTunnelId),
  ]
);

// =========================
// Team Knowledge Base
// =========================

// Postgres `tsvector` has no first-class Drizzle column type. This custom type
// maps it so the generated FTS column and its GIN index live in the schema and
// migrations rather than hand-written SQL drift.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// What a document is, so BA specs/requirements read distinctly from plain notes
// and runbooks. `doc` is the neutral default; `spec`/`requirement` carry the BA
// artifacts (acceptance criteria live as a markdown checklist in the body).
export const knowledgeDocTypeEnum = pgEnum("knowledge_doc_type", [
  "doc",
  "runbook",
  "spec",
  "requirement",
]);

// Top-level grouping for documents (e.g. "Runbooks", "Onboarding"). Managing
// collections is admin-only; documents inside are member-editable.
export const knowledgeCollections = pgTable("knowledge_collections", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),
  // lucide-react icon name, rendered in the tree. Null falls back to a default.
  icon: text("icon"),
  description: text("description"),
  // Sibling ordering among collections via a fractional-index rank string —
  // inserting between two ranks never renumbers neighbours. The column is
  // C-collated (see migration) so byte order matches the rank alphabet.
  rank: text("rank").notNull(),
  createdById: uuid("created_by_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => knowledgeCollections.id, { onDelete: "cascade" }),
    // Self-reference builds the nesting tree. set null (not cascade) so deleting
    // a parent re-parents children to the collection root instead of nuking the
    // whole subtree — the actions layer decides reparent vs cascade explicitly.
    parentId: uuid("parent_id").references(
      (): AnyPgColumn => knowledgeDocuments.id,
      {
        onDelete: "set null",
      }
    ),
    title: text("title").notNull(),
    docType: knowledgeDocTypeEnum("doc_type").notNull().default("doc"),
    // URL-friendly identifier, unique within a collection. Routed as
    // /knowledge/<slug>.
    slug: text("slug").notNull(),
    // Markdown source of truth — portable, diffable, vendor-neutral. TipTap is
    // only the editing surface; persistence is plain markdown.
    content: text("content").notNull().default(""),
    // Plain-text projection of `content`, computed in the actions layer. Feeds
    // the generated search vector; keeps markdown punctuation out of the index.
    contentText: text("content_text").notNull().default(""),
    // Generated full-text vector: title weighted 'A', body 'B'. STORED so the
    // GIN index covers it without a trigger. Recomputed by Postgres on write.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      (): SQL =>
        sql`setweight(to_tsvector('simple', coalesce(${knowledgeDocuments.title}, '')), 'A') || setweight(to_tsvector('simple', coalesce(${knowledgeDocuments.contentText}, '')), 'B')`
    ),
    // Sibling ordering within the same parent via a fractional-index rank
    // string (C-collated, see migration) — insert-between never renumbers.
    rank: text("rank").notNull(),
    // Optimistic-concurrency token. Bumped on every title/content write; the
    // update action guards on the version the editor loaded so two concurrent
    // edits can't silently overwrite each other (the loser is told to reload).
    version: integer("version").notNull().default(0),
    // Null = draft (author/admin-only visibility); set on publish.
    publishedAt: timestamp("published_at"),
    // Optional link to a project so a runbook can surface in project context.
    // set null: the doc outlives the project (standalone KB is primary).
    projectId: uuid("project_id").references(() => projects.id, {
      name: "knowledge_documents_project_id_projects_id_fk",
      onDelete: "set null",
    }),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedById: uuid("updated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Tree render reads a collection's docs ordered by (parent, rank).
    index("knowledge_documents_tree_idx").on(
      t.collectionId,
      t.parentId,
      t.rank
    ),
    // Routing resolves a doc by slug; globally unique so a `/knowledge/<slug>`
    // link in a body resolves to exactly one document (no cross-collection
    // ambiguity in the backlink graph).
    uniqueIndex("knowledge_documents_slug_idx").on(t.slug),
    // FTS ranking scans the generated vector.
    index("knowledge_documents_search_idx").using("gin", t.searchVector),
    // Inbound-link / project-context lookups.
    index("knowledge_documents_project_idx").on(t.projectId),
  ]
);

// Append-only history. Every update snapshots the PRIOR markdown before the
// write (in a transaction) so any revision can be restored.
export const knowledgeRevisions = pgTable(
  "knowledge_revisions",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    editedById: uuid("edited_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // History page lists a document's revisions newest-first.
    index("knowledge_revisions_document_idx").on(
      t.documentId,
      t.createdAt.desc()
    ),
  ]
);

// Backlink graph: an edge per internal /knowledge link found in a doc's body.
// Rebuilt on every save. PK is the pair so re-saving is an idempotent upsert.
export const knowledgeLinks = pgTable(
  "knowledge_links",
  {
    fromDocumentId: uuid("from_document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    toDocumentId: uuid("to_document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.fromDocumentId, t.toDocumentId] }),
    // "Referenced by" panel queries inbound edges.
    index("knowledge_links_to_idx").on(t.toDocumentId),
  ]
);

// Image/file attachments uploaded from the editor. Bytes live in object storage
// (Garage); this row is the metadata + the stable id the markdown body links to
// via /api/knowledge/asset/<id>. The markdown body is the single source of truth
// for which asset a document references (same as backlinks), so there is no
// document_id FK to keep in sync. No automatic GC yet: unreferenced uploads
// accumulate slowly — when it matters, prune out-of-band by extracting the asset
// ids from every document body (mirror extractLinkedSlugs) and deleting rows no
// body references, rather than maintaining a mutable FK.
export const knowledgeAttachments = pgTable("knowledge_attachments", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  // Object key in the bucket, e.g. "kb/<uuid>.webp". Server-generated; never
  // user input, so no path-traversal surface.
  storageKey: text("storage_key").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedById: uuid("uploaded_by_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type KnowledgeCollection = InferSelectModel<typeof knowledgeCollections>;
export type NewKnowledgeCollection = InferInsertModel<
  typeof knowledgeCollections
>;

export type KnowledgeDocument = InferSelectModel<typeof knowledgeDocuments>;
export type NewKnowledgeDocument = InferInsertModel<typeof knowledgeDocuments>;

export type KnowledgeRevision = InferSelectModel<typeof knowledgeRevisions>;
export type NewKnowledgeRevision = InferInsertModel<typeof knowledgeRevisions>;

export type KnowledgeAttachment = InferSelectModel<typeof knowledgeAttachments>;
export type NewKnowledgeAttachment = InferInsertModel<
  typeof knowledgeAttachments
>;

// A document plus its author display names and resolved relations, as shown in
// the reader. Credential-free already — KB has no secrets.
export type KnowledgeDocumentWithMeta = KnowledgeDocument & {
  collection: Pick<KnowledgeCollection, "id" | "name" | "icon">;
  createdBy: Pick<User, "id" | "name"> | null;
  updatedBy: Pick<User, "id" | "name" | "image"> | null;
};

// Lightweight node for the navigation tree — no body, no FTS columns.
export type KnowledgeTreeNode = Pick<
  KnowledgeDocument,
  "id" | "collectionId" | "parentId" | "title" | "slug" | "rank" | "docType"
> & { publishedAt: Date | null };

export type Server = InferSelectModel<typeof servers>;
export type NewServer = InferInsertModel<typeof servers>;

// The logical project (parent). Deployment-level data lives on `Environment`.
export type Project = InferSelectModel<typeof projects>;
export type NewProject = InferInsertModel<typeof projects>;

export type ProjectMember = InferSelectModel<typeof projectMembers>;
export type NewProjectMember = InferInsertModel<typeof projectMembers>;
export type ProjectApp = InferSelectModel<typeof projectApps>;
export type ProjectComponentBranch = InferSelectModel<
  typeof projectComponentBranches
>;

export type Issue = InferSelectModel<typeof issues>;
export type NewIssue = InferInsertModel<typeof issues>;

export type Milestone = InferSelectModel<typeof milestones>;
export type NewMilestone = InferInsertModel<typeof milestones>;

export type IssueAttachment = InferSelectModel<typeof issueAttachments>;
export type NewIssueAttachment = InferInsertModel<typeof issueAttachments>;

export type Notification = InferSelectModel<typeof notifications>;
export type NewNotification = InferInsertModel<typeof notifications>;

export type ActivityEvent = InferSelectModel<typeof activityLog>;
export type NewActivityEvent = InferInsertModel<typeof activityLog>;

export type IssueComment = InferSelectModel<typeof issueComments>;
export type NewIssueComment = InferInsertModel<typeof issueComments>;

export type Label = InferSelectModel<typeof labels>;
export type NewLabel = InferInsertModel<typeof labels>;

export type SavedView = InferSelectModel<typeof savedViews>;
export type NewSavedView = InferInsertModel<typeof savedViews>;
// The lightweight label shape attached to issues in list/detail payloads.
export type LabelLite = Pick<Label, "id" | "name" | "color">;

// A concrete deployment. Was historically called "Project" — now `Environment`.
export type Environment = InferSelectModel<typeof environments>;
export type NewEnvironment = InferInsertModel<typeof environments>;

export type EnvironmentService = InferSelectModel<typeof environmentServices>;
export type NewEnvironmentService = InferInsertModel<
  typeof environmentServices
>;

export type EnvironmentMailpit = InferSelectModel<typeof environmentMailpit>;

// A service row with its server record resolved. Consumers pick a service by
// role via lib/services#getServiceConfig.
export type ServiceWithServer = EnvironmentService & { server: Server };

// An environment's owner as views show it: `banned` drives the "Deactivated"
// marker for an offboarded owner, who stays linked.
export type EnvironmentOwner = Pick<User, "id" | "name" | "image" | "banned">;

export type EnvironmentWithServers = Environment & {
  services: ServiceWithServer[];
  owner: EnvironmentOwner | null;
};

// List-level projection: an environment plus the two db-service fields list
// views actually render (the engine badge and the database name). Joined from
// the `db` service in the list query so grids/switchers never need a per-row
// service fetch. Credential-free — safe for client components.
export type EnvironmentSummary = Environment &
  Pick<EnvironmentService, "dbType" | "dbName">;

// A summary plus its resolved owner, for the project grids that show it.
export type EnvironmentSummaryWithOwner = EnvironmentSummary & {
  owner: EnvironmentOwner | null;
};

// An environment summary plus its owning project's issue key, for readable-URL
// link builders (/[key]/[slug]/…), whether a Mailpit is connected (drives the
// sidebar's Mail entry), and when the current user last opened it (null when
// never; picks the landing environment when switching project). Credential-free.
export type EnvironmentListItem = EnvironmentSummary & {
  key: string;
  hasMailpit: boolean;
  // Roles of the services the environment has (backend always; db and
  // frontend optional). Drives which sidebar sections are shown.
  serviceRoles: ("db" | "backend" | "frontend")[];
  // The project has legacy jar/static components or releases (drives the
  // sidebar's Releases entry).
  projectReleasable: boolean;
  lastAccessedAt: Date | null;
};

// Credential-free projections handed to the client. SSH passwords, the DB admin
// password, and the mock-time API key must never cross the server/client
// boundary (RSC payloads are visible in the browser). Server code loads the
// full `EnvironmentWithServers` via lib/projects#loadEnvironmentWithServers;
// anything passed to a client component must be sanitized to these shapes first.
// A server seen through another object (lib/server-view#toSafeServer): no
// password and nothing about how the Panel signs in.
export type SafeServer = Omit<
  Server,
  | "password"
  | "hostKeyType"
  | "hostKey"
  | "hostKeyFingerprint"
  | "hostKeyPinnedAt"
  | "hostKeyOfferedType"
  | "hostKeyOffered"
  | "hostKeyOfferedFingerprint"
  | "sshKeyId"
  | "sshFrom"
  | "keyError"
>;

// A service stripped of its secrets, with presence flags so edit forms can show
// a "leave blank to keep" affordance and validate per-engine password
// requirements without ever receiving the secret.
export type SafeServiceWithServer = Omit<
  EnvironmentService,
  "dbPassword" | "mockTimeApiKey"
> & {
  server: SafeServer;
  hasDbPassword: boolean;
  hasMockTimeApiKey: boolean;
};

export type SafeEnvironmentWithServers = Environment & {
  services: SafeServiceWithServer[];
  owner: EnvironmentOwner | null;
};

export type Run = InferSelectModel<typeof runs>;

export type CiConnection = InferSelectModel<typeof ciConnections>;
export type App = InferSelectModel<typeof apps>;
export type AppComponent = InferSelectModel<typeof appComponents>;
export type DeployTarget = InferSelectModel<typeof deployTargets>;
export type AppVariableTemplate = InferSelectModel<typeof appVariableTemplates>;
export type EnvironmentVariable = InferSelectModel<typeof environmentVariables>;
export type DeployTargetKind = (typeof deployTargetKindEnum.enumValues)[number];
export type VariableKind = (typeof variableKindEnum.enumValues)[number];
export type NewDeployTarget = InferInsertModel<typeof deployTargets>;
export type Build = InferSelectModel<typeof builds>;
export type DatabaseHost = InferSelectModel<typeof databaseHosts>;
export type NewDatabaseHost = InferInsertModel<typeof databaseHosts>;
export type ProvisioningStep = InferSelectModel<typeof provisioningSteps>;
export type NewProvisioningStep = InferInsertModel<typeof provisioningSteps>;
export type EnvironmentDeployLock = InferSelectModel<
  typeof environmentDeployLocks
>;
export type Deployment = InferSelectModel<typeof deployments>;
export type NewRun = InferInsertModel<typeof runs>;

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type Passkey = InferSelectModel<typeof passkeys>;

export type Invitation = InferSelectModel<typeof invitations>;
export type NewInvitation = InferInsertModel<typeof invitations>;

export type S3Connection = InferSelectModel<typeof s3Connections>;
export type NewS3Connection = InferInsertModel<typeof s3Connections>;

// Credential-free projection handed to the client. `secretKey` must never cross
// the server/client boundary (RSC payloads are visible in the browser). Server
// code loads the full row; anything passed to a client component is sanitized
// to this shape first. `hasSecret` lets edit forms show a "leave blank to keep"
// affordance without ever receiving the secret. `isBackupDestination` marks the
// instance backup bucket, a restricted target (lib/restricted-targets).
export type SafeS3Connection = Omit<S3Connection, "secretKey"> & {
  hasSecret: boolean;
  isBackupDestination: boolean;
};

export type IssueStatus = (typeof issueStatusEnum.enumValues)[number];
export type IssueType = (typeof issueTypeEnum.enumValues)[number];
export type IssuePriority = (typeof issuePriorityEnum.enumValues)[number];

export type JiraConnection = InferSelectModel<typeof jiraConnections>;
export type NewJiraConnection = InferInsertModel<typeof jiraConnections>;

export type JiraProjectLink = InferSelectModel<typeof jiraProjectLinks>;
export type NewJiraProjectLink = InferInsertModel<typeof jiraProjectLinks>;

/**
 * Per-link overrides layered on the defaults in lib/jira/mapping.ts.
 *
 * `status` is keyed by the remote status NAME (lowercased) rather than its
 * category, because the whole reason to override is a workflow whose names
 * carry meaning the three Jira categories flatten away — "Ready for QA" and
 * "In Progress" are both `indeterminate`, but only one of them is `resolved`
 * here. `type`/`priority` are keyed by remote name for the same reason.
 */
export type JiraMappingOverrides = {
  status?: Record<string, IssueStatus>;
  type?: Record<string, IssueType>;
  priority?: Record<string, IssuePriority>;
};

// Credential-free projection handed to the client. Neither `apiToken` (a live
// Jira credential) nor `webhookSecret` (which authenticates inbound deliveries)
// may cross the server/client boundary — RSC payloads are readable in the
// browser. `hasToken` lets the edit form offer "leave blank to keep".
export type SafeJiraConnection = Omit<
  JiraConnection,
  "apiToken" | "webhookSecret"
> & { hasToken: boolean };

// A project's link plus the connection fields the settings card renders.
export type JiraLinkWithConnection = JiraProjectLink & {
  connection: Pick<JiraConnection, "id" | "name" | "baseUrl">;
};

export type CloudflareAccount = InferSelectModel<typeof cloudflareAccounts>;
export type CloudflareZone = InferSelectModel<typeof cloudflareZones>;
export type RemoteTunnel = InferSelectModel<typeof remoteTunnels>;
export type EnvironmentDomain = InferSelectModel<typeof environmentDomains>;
export type NewCloudflareZone = InferInsertModel<typeof cloudflareZones>;

// Credential-free projection handed to the client, mirroring SafeJiraConnection.
// `hasToken` lets the edit form offer "leave blank to keep the current token".
export type SafeCloudflareZone = Omit<CloudflareZone, "apiToken"> & {
  hasToken: boolean;
};

export type Tunnel = InferSelectModel<typeof tunnels>;
export type NewTunnel = InferInsertModel<typeof tunnels>;

// A tunnel plus the parent rows every tunnel view needs to render: which host
// it runs on and which zone its hostnames live in.
export type TunnelWithContext = Tunnel & {
  server: SafeServer;
  zone: Pick<CloudflareZone, "id" | "name" | "zoneId">;
};

// =========================
// Instance settings and backup history
// =========================

// The instance's own settings: a single row, id = 1 (seeded by the migration).
export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: integer("id").primaryKey().default(1),
    // Where instance backups go; null keeps them local only.
    backupDestinationId: uuid("backup_destination_id").references(
      () => s3Connections.id,
      { onDelete: "set null" }
    ),
    // HH:MM in the instance time zone.
    backupTime: text("backup_time").notNull().default("02:30"),
    backupKeepDaily: integer("backup_keep_daily").notNull().default(14),
    backupKeepWeekly: integer("backup_keep_weekly").notNull().default(8),
    // sha256(SECRETS_KEY) truncated to 16 hex chars; never the key itself.
    secretsKeyFingerprint: text("secrets_key_fingerprint"),
    updateChannel: text("update_channel", { enum: ["stable", "beta"] })
      .notNull()
      .default("stable"),
    autoUpdate: boolean("auto_update").notNull().default(false),
    // HH:MM in the instance time zone.
    autoUpdateWindow: text("auto_update_window").notNull().default("03:00"),
  },
  (t) => [
    check("instance_settings_singleton", sql`${t.id} = 1`),
    check(
      "instance_settings_update_channel_check",
      sql`${t.updateChannel} in ('stable', 'beta')`
    ),
  ]
);

export const instanceBackupStatusEnum = pgEnum("instance_backup_status", [
  "running",
  "succeeded",
  "failed",
]);

export const instanceBackupTriggerEnum = pgEnum("instance_backup_trigger", [
  "schedule",
  "manual",
  "update",
  "restore",
]);

export const instanceBackups = pgTable(
  "instance_backups",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
    status: instanceBackupStatusEnum("status").notNull().default("running"),
    trigger: instanceBackupTriggerEnum("trigger").notNull(),
    // OPSDECK_VERSION the backup was taken from.
    version: text("version").notNull(),
    location: text("location", { enum: ["s3", "local"] }).notNull(),
    objectKey: text("object_key"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    // Stable code of the failure, never display prose.
    errorCode: text("error_code"),
    // When an admin dismissed the failure notice.
    acknowledgedAt: timestamp("acknowledged_at"),
  },
  (t) => [
    check(
      "instance_backups_location_check",
      sql`${t.location} in ('s3', 'local')`
    ),
    index("instance_backups_started_at_idx").on(t.startedAt),
  ]
);

/** One server's outcome in an SSH key job; `code` is a stable error code. */
export type SshKeyJobResult = {
  serverId: string;
  name: string;
  ok: boolean;
  code: string | null;
};

// "Move all servers to the key" and "Rotate the key" runs, newest last. At
// most one is open (not finished) at a time, across both kinds: a move-all
// during a rotation could install the old key.
export const sshKeyJobs = pgTable(
  "ssh_key_jobs",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    kind: text("kind", { enum: ["moveAll", "rotate"] }).notNull(),
    // The admin who asked for it: the actor of its activity entries.
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    requestedAt: timestamp("requested_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    // Filled in server by server, so the page can show progress.
    results: jsonb("results").$type<SshKeyJobResult[]>().notNull().default([]),
    // Why the job itself stopped early (stable code); null when it ran out.
    errorCode: text("error_code"),
  },
  (t) => [
    check("ssh_key_jobs_kind_check", sql`${t.kind} in ('moveAll', 'rotate')`),
    uniqueIndex("ssh_key_jobs_one_open_idx")
      .on(sql`(true)`)
      .where(sql`finished_at is null`),
    index("ssh_key_jobs_requested_at_idx").on(t.requestedAt),
  ]
);

export const releaseStatusEnum = pgEnum("release_status", [
  "preparing",
  "ready",
  "failed",
]);

// A client release: the artifact of one successful jar/static deployment,
// copied into the Panel's Garage and kept until an admin deletes it.
export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    projectId: uuid("project_id")
      .notNull()
      // Restrict: a project delete must not orphan the release files in
      // Garage, so its releases are deleted first (removeProject refuses).
      .references(() => projects.id, {
        name: "releases_project_id_projects_id_fk",
        onDelete: "restrict",
      }),
    componentKey: text("component_key")
      .notNull()
      .references(() => appComponents.componentKey, {
        name: "releases_component_key_app_components_component_key_fk",
        onDelete: "restrict",
      }),
    environmentId: uuid("environment_id").references(() => environments.id, {
      name: "releases_environment_id_environments_id_fk",
      onDelete: "set null",
    }),
    // Snapshot: the environment may be torn down later.
    environmentName: text("environment_name").notNull(),
    deploymentId: uuid("deployment_id").references(() => deployments.id, {
      name: "releases_deployment_id_deployments_id_fk",
      onDelete: "set null",
    }),
    branch: text("branch").notNull(),
    tag: text("tag").notNull(),
    commitSha: text("commit_sha").notNull(),
    version: text("version").notNull(),
    notes: text("notes"),
    status: releaseStatusEnum("status").notNull().default("preparing"),
    error: text("error"),
    objectKey: text("object_key"),
    fileName: text("file_name"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    createdBy: uuid("created_by").references(() => users.id, {
      name: "releases_created_by_users_id_fk",
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    readyAt: timestamp("ready_at"),
  },
  (t) => [
    uniqueIndex("releases_version_idx")
      .on(t.projectId, t.componentKey, t.version)
      .where(sql`status <> 'failed'`),
    index("releases_project_idx").on(t.projectId, t.createdAt),
  ]
);

export type Release = InferSelectModel<typeof releases>;
export type InstanceSettings = InferSelectModel<typeof instanceSettings>;
export type SshKeyJob = InferSelectModel<typeof sshKeyJobs>;
export type TeardownStep = InferSelectModel<typeof teardownSteps>;
export type EnvironmentArchive = InferSelectModel<typeof environmentArchives>;
export type InstanceBackup = InferSelectModel<typeof instanceBackups>;
export type NewInstanceBackup = InferInsertModel<typeof instanceBackups>;
