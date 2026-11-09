--
-- PostgreSQL database dump
--

\restrict j0kcJyNFdT4DwfqPwzo80S2VoVl0werNsobBRRv7Ch1Fi2HgBaD1jzyXrwJniqM

-- Dumped from database version 18.1 (Debian 18.1-1.pgdg13+2)
-- Dumped by pg_dump version 18.1 (Debian 18.1-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: ci_provider; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ci_provider AS ENUM (
    'woodpecker'
);


--
-- Name: database_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.database_kind AS ENUM (
    'shared',
    'container',
    'external'
);


--
-- Name: database_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.database_type AS ENUM (
    'postgres',
    'mssql',
    'mysql'
);


--
-- Name: deploy_trigger; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.deploy_trigger AS ENUM (
    'auto',
    'manual',
    'rollback'
);


--
-- Name: deployment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.deployment_status AS ENUM (
    'queued',
    'running',
    'success',
    'failed',
    'superseded',
    'held'
);


--
-- Name: domain_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.domain_kind AS ENUM (
    'tunnel',
    'external'
);


--
-- Name: environment_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.environment_kind AS ENUM (
    'qa',
    'dev',
    'release',
    'sandbox',
    'prod'
);


--
-- Name: forge_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.forge_kind AS ENUM (
    'bitbucket',
    'github',
    'gitlab',
    'gitea',
    'forgejo'
);


--
-- Name: issue_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.issue_priority AS ENUM (
    'low',
    'medium',
    'high',
    'urgent'
);


--
-- Name: issue_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.issue_status AS ENUM (
    'open',
    'in_progress',
    'resolved',
    'closed'
);


--
-- Name: issue_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.issue_type AS ENUM (
    'bug',
    'task',
    'story',
    'epic'
);


--
-- Name: jira_flavor; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.jira_flavor AS ENUM (
    'cloud',
    'datacenter'
);


--
-- Name: jira_sync_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.jira_sync_status AS ENUM (
    'ok',
    'partial',
    'failed'
);


--
-- Name: knowledge_doc_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.knowledge_doc_type AS ENUM (
    'doc',
    'runbook',
    'spec',
    'requirement'
);


--
-- Name: notification_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_type AS ENUM (
    'issue_assigned',
    'run_failed',
    'issue_mention',
    'jira_push_failed'
);


--
-- Name: pipeline_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pipeline_mode AS ENUM (
    'custom',
    'generated'
);


--
-- Name: project_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.project_role AS ENUM (
    'viewer',
    'qa',
    'engineer'
);


--
-- Name: provisioning_step_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.provisioning_step_kind AS ENUM (
    'prepare_deploy_dir',
    'create_database',
    'deploy',
    'tunnel_route',
    'access_app',
    'dns_record'
);


--
-- Name: provisioning_step_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.provisioning_step_status AS ENUM (
    'pending',
    'running',
    'done',
    'failed'
);


--
-- Name: run_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.run_kind AS ENUM (
    'backup',
    'restore',
    'mock_time',
    'test',
    'deploy',
    'provision'
);


--
-- Name: run_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.run_status AS ENUM (
    'started',
    'success',
    'failed'
);


--
-- Name: server_placement; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.server_placement AS ENUM (
    'restricted',
    'open'
);


--
-- Name: service_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.service_role AS ENUM (
    'db',
    'backend',
    'frontend',
    'worker',
    'cache',
    'gateway'
);


--
-- Name: service_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.service_type AS ENUM (
    'docker',
    'systemd',
    'kubernetes'
);


--
-- Name: variable_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.variable_kind AS ENUM (
    'plain',
    'secret',
    'generated'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    access_token text,
    refresh_token text,
    access_token_expires_at timestamp without time zone,
    refresh_token_expires_at timestamp without time zone,
    scope text,
    id_token text,
    password text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_log (
    id uuid DEFAULT uuidv7() NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    entity_type text,
    entity_id uuid,
    data jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: app_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_components (
    component_key text CONSTRAINT deploy_apps_app_key_not_null NOT NULL,
    bundle_image text CONSTRAINT deploy_apps_bundle_image_not_null NOT NULL,
    notify_secret text CONSTRAINT deploy_apps_notify_secret_not_null NOT NULL,
    created_at timestamp without time zone DEFAULT now() CONSTRAINT deploy_apps_created_at_not_null NOT NULL,
    app_id uuid NOT NULL,
    ci_connection_id uuid NOT NULL,
    repo_full_name text NOT NULL,
    ci_repo_id text,
    pipeline_mode public.pipeline_mode DEFAULT 'custom'::public.pipeline_mode NOT NULL,
    build_spec jsonb,
    pipeline_file_commits jsonb
);


--
-- Name: app_variable_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_variable_templates (
    id uuid DEFAULT uuidv7() NOT NULL,
    app_id uuid NOT NULL,
    name text NOT NULL,
    kind public.variable_kind NOT NULL,
    required boolean DEFAULT false NOT NULL,
    default_value text,
    generated_length integer,
    escrow boolean DEFAULT false NOT NULL,
    description text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_variable_templates_generated_length_check CHECK (((generated_length >= 16) AND (generated_length <= 128)))
);


--
-- Name: apps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apps (
    id uuid DEFAULT uuidv7() NOT NULL,
    app_key text NOT NULL,
    name text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: builds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.builds (
    id uuid DEFAULT uuidv7() NOT NULL,
    component_key text CONSTRAINT builds_app_key_not_null NOT NULL,
    branch text NOT NULL,
    tag text NOT NULL,
    commit_sha text NOT NULL,
    pipeline_url text,
    received_at timestamp without time zone DEFAULT now() NOT NULL,
    pushed_by text,
    commit_author_email text,
    commit_message text
);


--
-- Name: ci_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ci_connections (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    provider public.ci_provider NOT NULL,
    forge public.forge_kind NOT NULL,
    base_url text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    api_token text,
    forge_username text,
    forge_token text
);


--
-- Name: cloudflare_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloudflare_accounts (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id text NOT NULL,
    name text NOT NULL,
    api_token text NOT NULL,
    access_idp_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: cloudflare_zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloudflare_zones (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    zone_id text NOT NULL,
    api_token text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: database_hosts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.database_hosts (
    id uuid DEFAULT uuidv7() NOT NULL,
    server_id uuid NOT NULL,
    container_name text NOT NULL,
    backup_path text NOT NULL,
    label text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    network text,
    CONSTRAINT database_hosts_network_format CHECK (((network IS NULL) OR (network ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'::text)))
);


--
-- Name: deploy_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deploy_targets (
    id uuid DEFAULT uuidv7() NOT NULL,
    environment_id uuid NOT NULL,
    component_key text CONSTRAINT deploy_targets_app_key_not_null NOT NULL,
    server_id uuid NOT NULL,
    source_branch text NOT NULL,
    auto_deploy boolean DEFAULT false NOT NULL,
    deploy_dir text NOT NULL,
    services text[] NOT NULL,
    tag_variable text DEFAULT 'IMAGE_TAG'::text NOT NULL,
    pre_start_command text,
    health_url text,
    health_timeout_seconds integer DEFAULT 180 NOT NULL,
    backup_before_deploy boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    deploy_next_build boolean DEFAULT false NOT NULL
);


--
-- Name: deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deployments (
    id uuid DEFAULT uuidv7() NOT NULL,
    target_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    run_id uuid,
    tag text NOT NULL,
    trigger public.deploy_trigger NOT NULL,
    status public.deployment_status DEFAULT 'queued'::public.deployment_status NOT NULL,
    build_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    started_at timestamp without time zone,
    heartbeat_at timestamp without time zone,
    script_started_at timestamp without time zone,
    finished_at timestamp without time zone
);


--
-- Name: environment_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.environment_access (
    user_id uuid CONSTRAINT project_access_user_id_not_null NOT NULL,
    environment_id uuid CONSTRAINT project_access_project_id_not_null NOT NULL,
    last_accessed_at timestamp without time zone DEFAULT now() CONSTRAINT project_access_last_accessed_at_not_null NOT NULL
);


--
-- Name: environment_deploy_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.environment_deploy_locks (
    environment_id uuid NOT NULL,
    locked_by uuid,
    reason text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: environment_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.environment_domains (
    environment_id uuid NOT NULL,
    kind public.domain_kind NOT NULL,
    hostname text NOT NULL,
    zone_id uuid,
    remote_tunnel_id uuid,
    access_policy_id text,
    access_app_id text,
    dns_record_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT environment_domains_tunnel_refs CHECK (((kind <> 'tunnel'::public.domain_kind) OR ((zone_id IS NOT NULL) AND (remote_tunnel_id IS NOT NULL))))
);


--
-- Name: environment_mailpit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.environment_mailpit (
    environment_id uuid NOT NULL,
    url text NOT NULL,
    username text,
    password text,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: environment_services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.environment_services (
    id uuid DEFAULT uuidv7() NOT NULL,
    environment_id uuid NOT NULL,
    role public.service_role NOT NULL,
    server_id uuid NOT NULL,
    service_type public.service_type NOT NULL,
    service_name text NOT NULL,
    db_type public.database_type,
    db_name text,
    db_password text,
    db_backup_path text,
    mock_time_api_url text,
    mock_time_api_key text,
    db_user text,
    db_kind public.database_kind,
    database_host_id uuid,
    db_role text,
    db_password_variable text
);


--
-- Name: environment_variables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.environment_variables (
    id uuid DEFAULT uuidv7() NOT NULL,
    environment_id uuid NOT NULL,
    name text NOT NULL,
    kind public.variable_kind NOT NULL,
    value text NOT NULL,
    escrow boolean DEFAULT false NOT NULL,
    updated_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: environments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.environments (
    id uuid DEFAULT uuidv7() CONSTRAINT projects_id_not_null NOT NULL,
    name text CONSTRAINT projects_name_not_null NOT NULL,
    project_id uuid NOT NULL,
    kind public.environment_kind,
    slug text NOT NULL,
    url text,
    owner_id uuid,
    app_id uuid,
    env_file_managed boolean DEFAULT false NOT NULL,
    entry_port integer,
    CONSTRAINT environments_entry_port_range CHECK (((entry_port >= 1) AND (entry_port <= 65535)))
);


--
-- Name: invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitations (
    id uuid DEFAULT uuidv7() NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    token text NOT NULL,
    invited_by_id uuid,
    expires_at timestamp without time zone NOT NULL,
    accepted_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'member'::text NOT NULL
);


--
-- Name: issue_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.issue_attachments (
    id uuid DEFAULT uuidv7() NOT NULL,
    issue_id uuid NOT NULL,
    storage_key text NOT NULL,
    filename text NOT NULL,
    mime text NOT NULL,
    size_bytes integer NOT NULL,
    uploaded_by_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: issue_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.issue_comments (
    id uuid DEFAULT uuidv7() NOT NULL,
    issue_id uuid NOT NULL,
    author_id uuid,
    body text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    jira_comment_id text
);


--
-- Name: issue_labels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.issue_labels (
    issue_id uuid NOT NULL,
    label_id uuid NOT NULL
);


--
-- Name: issues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.issues (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    number integer NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    status public.issue_status DEFAULT 'open'::public.issue_status NOT NULL,
    environment_id uuid,
    created_by_id uuid,
    assignee_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    type public.issue_type DEFAULT 'task'::public.issue_type NOT NULL,
    priority public.issue_priority DEFAULT 'medium'::public.issue_priority NOT NULL,
    estimate integer,
    parent_id uuid,
    milestone_id uuid,
    jira_issue_id text,
    jira_key text,
    jira_updated_at timestamp without time zone,
    jira_synced_at timestamp without time zone
);


--
-- Name: jira_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jira_connections (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    base_url text NOT NULL,
    flavor public.jira_flavor DEFAULT 'cloud'::public.jira_flavor NOT NULL,
    email text,
    api_token text NOT NULL,
    webhook_secret text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: jira_project_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jira_project_links (
    project_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    jira_project_key text NOT NULL,
    jql_filter text,
    enabled boolean DEFAULT true NOT NULL,
    push_enabled boolean DEFAULT false NOT NULL,
    mapping_overrides jsonb,
    last_sync_at timestamp without time zone,
    last_sync_status public.jira_sync_status,
    last_sync_error text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: knowledge_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_attachments (
    id uuid DEFAULT uuidv7() NOT NULL,
    storage_key text NOT NULL,
    mime text NOT NULL,
    size_bytes integer NOT NULL,
    uploaded_by_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: knowledge_collections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_collections (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    icon text,
    description text,
    rank text CONSTRAINT knowledge_collections_position_not_null NOT NULL COLLATE pg_catalog."C",
    created_by_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: knowledge_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_documents (
    id uuid DEFAULT uuidv7() NOT NULL,
    collection_id uuid NOT NULL,
    parent_id uuid,
    title text NOT NULL,
    slug text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    content_text text DEFAULT ''::text NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('simple'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, COALESCE(content_text, ''::text)), 'B'::"char"))) STORED,
    rank text CONSTRAINT knowledge_documents_position_not_null NOT NULL COLLATE pg_catalog."C",
    published_at timestamp without time zone,
    project_id uuid,
    created_by_id uuid,
    updated_by_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    doc_type public.knowledge_doc_type DEFAULT 'doc'::public.knowledge_doc_type NOT NULL
);


--
-- Name: knowledge_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_links (
    from_document_id uuid NOT NULL,
    to_document_id uuid NOT NULL
);


--
-- Name: knowledge_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_revisions (
    id uuid DEFAULT uuidv7() NOT NULL,
    document_id uuid NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    edited_by_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: labels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.labels (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#64748b'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: milestones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.milestones (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    due_at timestamp without time zone,
    closed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    type public.notification_type NOT NULL,
    data jsonb NOT NULL,
    href text,
    read_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: passkeys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.passkeys (
    id uuid NOT NULL,
    name text,
    user_id uuid NOT NULL,
    credential_id text NOT NULL,
    public_key text NOT NULL,
    counter integer DEFAULT 0 NOT NULL,
    device_type text NOT NULL,
    backed_up boolean DEFAULT false NOT NULL,
    transports text,
    aaguid text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: project_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_members (
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.project_role NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT uuidv7() CONSTRAINT projects_id_not_null1 NOT NULL,
    name text CONSTRAINT projects_name_not_null1 NOT NULL,
    key text NOT NULL,
    client text,
    description text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    default_server_id uuid
);


--
-- Name: provisioning_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provisioning_steps (
    id uuid DEFAULT uuidv7() NOT NULL,
    environment_id uuid NOT NULL,
    "position" integer NOT NULL,
    kind public.provisioning_step_kind NOT NULL,
    params jsonb NOT NULL,
    status public.provisioning_step_status DEFAULT 'pending'::public.provisioning_step_status NOT NULL,
    last_error text,
    last_run_id uuid,
    completed_at timestamp without time zone,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: remote_tunnels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_tunnels (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    server_id uuid NOT NULL,
    tunnel_id text NOT NULL,
    name text NOT NULL,
    origin_host text DEFAULT 'localhost'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    id uuid DEFAULT uuidv7() CONSTRAINT tasks_id_not_null NOT NULL,
    environment_id uuid CONSTRAINT tasks_project_id_not_null NOT NULL,
    description text CONSTRAINT tasks_description_not_null NOT NULL,
    run_at timestamp without time zone CONSTRAINT tasks_run_at_not_null NOT NULL,
    completed_at timestamp without time zone,
    user_id uuid,
    status public.run_status DEFAULT 'started'::public.run_status CONSTRAINT tasks_status_not_null NOT NULL,
    output text DEFAULT ''::text CONSTRAINT tasks_output_not_null NOT NULL,
    error_message text,
    kind public.run_kind,
    issue_id uuid,
    acknowledged_at timestamp without time zone,
    acknowledged_by_id uuid,
    triggered_by text
);


--
-- Name: s3_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.s3_connections (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    endpoint text NOT NULL,
    region text DEFAULT 'us-east-1'::text NOT NULL,
    bucket text NOT NULL,
    access_key_id text NOT NULL,
    secret_key text NOT NULL,
    force_path_style boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: saved_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_views (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    params jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.servers (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    host text NOT NULL,
    username text NOT NULL,
    password text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    sftp_root text DEFAULT '/'::text NOT NULL,
    placement public.server_placement DEFAULT 'restricted'::public.server_placement NOT NULL,
    preflight jsonb,
    preflight_at timestamp without time zone
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    impersonated_by uuid
);


--
-- Name: tunnels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tunnels (
    id uuid DEFAULT uuidv7() NOT NULL,
    zone_id uuid NOT NULL,
    server_id uuid NOT NULL,
    name text NOT NULL,
    tunnel_id text NOT NULL,
    stack_dir text NOT NULL,
    config_path text DEFAULT 'cloudflared/config.yml'::text NOT NULL,
    container_name text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    banned boolean DEFAULT false NOT NULL,
    ban_reason text,
    ban_expires timestamp without time zone,
    jira_account_id text,
    title text,
    bio text,
    timezone text,
    working_hours jsonb,
    status_emoji text,
    status_text text,
    status_expires_at timestamp without time zone,
    avatar_source text,
    accent_color text,
    motif text
);


--
-- Name: verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verifications (
    id uuid NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: activity_log activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_pkey PRIMARY KEY (id);


--
-- Name: app_components app_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_components
    ADD CONSTRAINT app_components_pkey PRIMARY KEY (component_key);


--
-- Name: app_variable_templates app_variable_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_variable_templates
    ADD CONSTRAINT app_variable_templates_pkey PRIMARY KEY (id);


--
-- Name: apps apps_app_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_app_key_unique UNIQUE (app_key);


--
-- Name: apps apps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_pkey PRIMARY KEY (id);


--
-- Name: builds builds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.builds
    ADD CONSTRAINT builds_pkey PRIMARY KEY (id);


--
-- Name: ci_connections ci_connections_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_connections
    ADD CONSTRAINT ci_connections_name_unique UNIQUE (name);


--
-- Name: ci_connections ci_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_connections
    ADD CONSTRAINT ci_connections_pkey PRIMARY KEY (id);


--
-- Name: cloudflare_accounts cloudflare_accounts_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloudflare_accounts
    ADD CONSTRAINT cloudflare_accounts_account_id_key UNIQUE (account_id);


--
-- Name: cloudflare_accounts cloudflare_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloudflare_accounts
    ADD CONSTRAINT cloudflare_accounts_pkey PRIMARY KEY (id);


--
-- Name: cloudflare_zones cloudflare_zones_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloudflare_zones
    ADD CONSTRAINT cloudflare_zones_name_unique UNIQUE (name);


--
-- Name: cloudflare_zones cloudflare_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloudflare_zones
    ADD CONSTRAINT cloudflare_zones_pkey PRIMARY KEY (id);


--
-- Name: database_hosts database_hosts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_hosts
    ADD CONSTRAINT database_hosts_pkey PRIMARY KEY (id);


--
-- Name: deploy_targets deploy_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deploy_targets
    ADD CONSTRAINT deploy_targets_pkey PRIMARY KEY (id);


--
-- Name: deployments deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_pkey PRIMARY KEY (id);


--
-- Name: environment_deploy_locks environment_deploy_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_deploy_locks
    ADD CONSTRAINT environment_deploy_locks_pkey PRIMARY KEY (environment_id);


--
-- Name: environment_domains environment_domains_hostname_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_domains
    ADD CONSTRAINT environment_domains_hostname_key UNIQUE (hostname);


--
-- Name: environment_domains environment_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_domains
    ADD CONSTRAINT environment_domains_pkey PRIMARY KEY (environment_id);


--
-- Name: environment_mailpit environment_mailpit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_mailpit
    ADD CONSTRAINT environment_mailpit_pkey PRIMARY KEY (environment_id);


--
-- Name: environment_services environment_services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_services
    ADD CONSTRAINT environment_services_pkey PRIMARY KEY (id);


--
-- Name: environment_variables environment_variables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_variables
    ADD CONSTRAINT environment_variables_pkey PRIMARY KEY (id);


--
-- Name: environments environments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_token_key UNIQUE (token);


--
-- Name: issue_attachments issue_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_attachments
    ADD CONSTRAINT issue_attachments_pkey PRIMARY KEY (id);


--
-- Name: issue_comments issue_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_comments
    ADD CONSTRAINT issue_comments_pkey PRIMARY KEY (id);


--
-- Name: issue_labels issue_labels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_labels
    ADD CONSTRAINT issue_labels_pkey PRIMARY KEY (issue_id, label_id);


--
-- Name: issues issues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_pkey PRIMARY KEY (id);


--
-- Name: jira_connections jira_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_connections
    ADD CONSTRAINT jira_connections_pkey PRIMARY KEY (id);


--
-- Name: jira_project_links jira_project_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_project_links
    ADD CONSTRAINT jira_project_links_pkey PRIMARY KEY (project_id);


--
-- Name: knowledge_attachments knowledge_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_attachments
    ADD CONSTRAINT knowledge_attachments_pkey PRIMARY KEY (id);


--
-- Name: knowledge_collections knowledge_collections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_collections
    ADD CONSTRAINT knowledge_collections_pkey PRIMARY KEY (id);


--
-- Name: knowledge_documents knowledge_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_documents
    ADD CONSTRAINT knowledge_documents_pkey PRIMARY KEY (id);


--
-- Name: knowledge_links knowledge_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_links
    ADD CONSTRAINT knowledge_links_pkey PRIMARY KEY (from_document_id, to_document_id);


--
-- Name: knowledge_revisions knowledge_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_revisions
    ADD CONSTRAINT knowledge_revisions_pkey PRIMARY KEY (id);


--
-- Name: labels labels_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labels
    ADD CONSTRAINT labels_name_key UNIQUE (name);


--
-- Name: labels labels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labels
    ADD CONSTRAINT labels_pkey PRIMARY KEY (id);


--
-- Name: milestones milestones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.milestones
    ADD CONSTRAINT milestones_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: passkeys passkeys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passkeys
    ADD CONSTRAINT passkeys_pkey PRIMARY KEY (id);


--
-- Name: environment_access project_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_access
    ADD CONSTRAINT project_access_pkey PRIMARY KEY (user_id, environment_id);


--
-- Name: project_members project_members_project_id_user_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_project_id_user_id_pk PRIMARY KEY (project_id, user_id);


--
-- Name: projects projects_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_key_unique UNIQUE (key);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: provisioning_steps provisioning_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioning_steps
    ADD CONSTRAINT provisioning_steps_pkey PRIMARY KEY (id);


--
-- Name: remote_tunnels remote_tunnels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_tunnels
    ADD CONSTRAINT remote_tunnels_pkey PRIMARY KEY (id);


--
-- Name: s3_connections s3_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.s3_connections
    ADD CONSTRAINT s3_connections_pkey PRIMARY KEY (id);


--
-- Name: saved_views saved_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_views
    ADD CONSTRAINT saved_views_pkey PRIMARY KEY (id);


--
-- Name: servers servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_key UNIQUE (token);


--
-- Name: runs tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: tunnels tunnels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tunnels
    ADD CONSTRAINT tunnels_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: verifications verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verifications
    ADD CONSTRAINT verifications_pkey PRIMARY KEY (id);


--
-- Name: accounts_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_user_idx ON public.accounts USING btree (user_id);


--
-- Name: activity_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_created_idx ON public.activity_log USING btree (created_at DESC);


--
-- Name: app_components_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_components_app_idx ON public.app_components USING btree (app_id);


--
-- Name: app_components_ci_repo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_components_ci_repo_idx ON public.app_components USING btree (ci_connection_id, ci_repo_id);


--
-- Name: app_variable_templates_app_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_variable_templates_app_name_idx ON public.app_variable_templates USING btree (app_id, name);


--
-- Name: builds_component_branch_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX builds_component_branch_received_idx ON public.builds USING btree (component_key, branch, received_at DESC);


--
-- Name: builds_component_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX builds_component_tag_idx ON public.builds USING btree (component_key, tag);


--
-- Name: database_hosts_server_container_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX database_hosts_server_container_idx ON public.database_hosts USING btree (server_id, container_name);


--
-- Name: database_hosts_server_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX database_hosts_server_idx ON public.database_hosts USING btree (server_id);


--
-- Name: deploy_targets_component_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deploy_targets_component_idx ON public.deploy_targets USING btree (component_key);


--
-- Name: deploy_targets_environment_component_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deploy_targets_environment_component_idx ON public.deploy_targets USING btree (environment_id, component_key);


--
-- Name: deployments_one_running_per_env_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deployments_one_running_per_env_idx ON public.deployments USING btree (environment_id) WHERE (status = 'running'::public.deployment_status);


--
-- Name: deployments_target_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deployments_target_created_idx ON public.deployments USING btree (target_id, created_at DESC);


--
-- Name: environment_access_user_recency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX environment_access_user_recency_idx ON public.environment_access USING btree (user_id, last_accessed_at DESC NULLS LAST);


--
-- Name: environment_deploy_locks_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX environment_deploy_locks_expires_at_idx ON public.environment_deploy_locks USING btree (expires_at);


--
-- Name: environment_deploy_locks_locked_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX environment_deploy_locks_locked_by_idx ON public.environment_deploy_locks USING btree (locked_by);


--
-- Name: environment_domains_remote_tunnel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX environment_domains_remote_tunnel_idx ON public.environment_domains USING btree (remote_tunnel_id);


--
-- Name: environment_domains_zone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX environment_domains_zone_idx ON public.environment_domains USING btree (zone_id);


--
-- Name: environment_services_database_host_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX environment_services_database_host_idx ON public.environment_services USING btree (database_host_id);


--
-- Name: environment_services_env_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX environment_services_env_role_idx ON public.environment_services USING btree (environment_id, role);


--
-- Name: environment_services_host_db_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX environment_services_host_db_name_idx ON public.environment_services USING btree (database_host_id, db_name) WHERE (database_host_id IS NOT NULL);


--
-- Name: environment_services_server_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX environment_services_server_idx ON public.environment_services USING btree (server_id);


--
-- Name: environment_variables_environment_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX environment_variables_environment_name_idx ON public.environment_variables USING btree (environment_id, name);


--
-- Name: environment_variables_updated_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX environment_variables_updated_by_idx ON public.environment_variables USING btree (updated_by);


--
-- Name: environments_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX environments_app_idx ON public.environments USING btree (app_id);


--
-- Name: environments_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX environments_owner_idx ON public.environments USING btree (owner_id);


--
-- Name: environments_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX environments_project_idx ON public.environments USING btree (project_id);


--
-- Name: environments_project_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX environments_project_name_idx ON public.environments USING btree (project_id, name);


--
-- Name: environments_project_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX environments_project_slug_idx ON public.environments USING btree (project_id, slug);


--
-- Name: invitations_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitations_email_idx ON public.invitations USING btree (email);


--
-- Name: issue_attachments_issue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issue_attachments_issue_idx ON public.issue_attachments USING btree (issue_id);


--
-- Name: issue_comments_issue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issue_comments_issue_idx ON public.issue_comments USING btree (issue_id, created_at);


--
-- Name: issue_comments_jira_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX issue_comments_jira_id_idx ON public.issue_comments USING btree (jira_comment_id) WHERE (jira_comment_id IS NOT NULL);


--
-- Name: issue_labels_label_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issue_labels_label_idx ON public.issue_labels USING btree (label_id);


--
-- Name: issues_assignee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_assignee_idx ON public.issues USING btree (assignee_id);


--
-- Name: issues_jira_issue_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX issues_jira_issue_id_idx ON public.issues USING btree (jira_issue_id) WHERE (jira_issue_id IS NOT NULL);


--
-- Name: issues_milestone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_milestone_idx ON public.issues USING btree (milestone_id);


--
-- Name: issues_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_parent_idx ON public.issues USING btree (parent_id);


--
-- Name: issues_project_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX issues_project_number_idx ON public.issues USING btree (project_id, number);


--
-- Name: issues_project_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_project_status_idx ON public.issues USING btree (project_id, status);


--
-- Name: issues_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_status_idx ON public.issues USING btree (status);


--
-- Name: issues_updated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_updated_at_idx ON public.issues USING btree (updated_at DESC);


--
-- Name: jira_links_connection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jira_links_connection_idx ON public.jira_project_links USING btree (connection_id);


--
-- Name: jira_links_connection_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX jira_links_connection_key_idx ON public.jira_project_links USING btree (connection_id, jira_project_key);


--
-- Name: knowledge_documents_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_documents_project_idx ON public.knowledge_documents USING btree (project_id);


--
-- Name: knowledge_documents_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_documents_search_idx ON public.knowledge_documents USING gin (search_vector);


--
-- Name: knowledge_documents_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX knowledge_documents_slug_idx ON public.knowledge_documents USING btree (slug);


--
-- Name: knowledge_documents_tree_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_documents_tree_idx ON public.knowledge_documents USING btree (collection_id, parent_id, rank);


--
-- Name: knowledge_links_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_links_to_idx ON public.knowledge_links USING btree (to_document_id);


--
-- Name: knowledge_revisions_document_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_revisions_document_idx ON public.knowledge_revisions USING btree (document_id, created_at DESC NULLS LAST);


--
-- Name: milestones_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX milestones_project_idx ON public.milestones USING btree (project_id);


--
-- Name: notifications_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_created_idx ON public.notifications USING btree (user_id, created_at DESC NULLS LAST);


--
-- Name: passkeys_credential_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX passkeys_credential_id_idx ON public.passkeys USING btree (credential_id);


--
-- Name: passkeys_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX passkeys_user_idx ON public.passkeys USING btree (user_id);


--
-- Name: project_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_members_user_idx ON public.project_members USING btree (user_id);


--
-- Name: provisioning_steps_environment_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX provisioning_steps_environment_position_idx ON public.provisioning_steps USING btree (environment_id, "position");


--
-- Name: provisioning_steps_last_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provisioning_steps_last_run_idx ON public.provisioning_steps USING btree (last_run_id);


--
-- Name: remote_tunnels_account_tunnel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX remote_tunnels_account_tunnel_idx ON public.remote_tunnels USING btree (account_id, tunnel_id);


--
-- Name: remote_tunnels_server_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX remote_tunnels_server_idx ON public.remote_tunnels USING btree (server_id);


--
-- Name: runs_attention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_attention_idx ON public.runs USING btree (run_at DESC NULLS LAST) WHERE ((status = 'failed'::public.run_status) AND (acknowledged_at IS NULL));


--
-- Name: runs_environment_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_environment_run_idx ON public.runs USING btree (environment_id, run_at DESC NULLS LAST);


--
-- Name: runs_issue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_issue_idx ON public.runs USING btree (issue_id);


--
-- Name: runs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_status_idx ON public.runs USING btree (status);


--
-- Name: saved_views_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX saved_views_user_idx ON public.saved_views USING btree (user_id, created_at);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);


--
-- Name: tunnels_server_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tunnels_server_idx ON public.tunnels USING btree (server_id);


--
-- Name: tunnels_server_tunnel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tunnels_server_tunnel_idx ON public.tunnels USING btree (server_id, tunnel_id);


--
-- Name: tunnels_zone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tunnels_zone_idx ON public.tunnels USING btree (zone_id);


--
-- Name: users_active_name_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_active_name_lower_idx ON public.users USING btree (lower(name)) WHERE (banned = false);


--
-- Name: accounts accounts_user_id_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_users_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: activity_log activity_log_actor_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_actor_id_users_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: app_components app_components_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_components
    ADD CONSTRAINT app_components_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE RESTRICT;


--
-- Name: app_components app_components_ci_connection_id_ci_connections_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_components
    ADD CONSTRAINT app_components_ci_connection_id_ci_connections_id_fk FOREIGN KEY (ci_connection_id) REFERENCES public.ci_connections(id) ON DELETE RESTRICT;


--
-- Name: app_variable_templates app_variable_templates_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_variable_templates
    ADD CONSTRAINT app_variable_templates_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: builds builds_component_key_app_components_component_key_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.builds
    ADD CONSTRAINT builds_component_key_app_components_component_key_fk FOREIGN KEY (component_key) REFERENCES public.app_components(component_key) ON DELETE CASCADE;


--
-- Name: database_hosts database_hosts_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_hosts
    ADD CONSTRAINT database_hosts_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE RESTRICT;


--
-- Name: deploy_targets deploy_targets_component_key_app_components_component_key_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deploy_targets
    ADD CONSTRAINT deploy_targets_component_key_app_components_component_key_fk FOREIGN KEY (component_key) REFERENCES public.app_components(component_key) ON DELETE RESTRICT;


--
-- Name: deploy_targets deploy_targets_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deploy_targets
    ADD CONSTRAINT deploy_targets_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: deploy_targets deploy_targets_server_id_servers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deploy_targets
    ADD CONSTRAINT deploy_targets_server_id_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE RESTRICT;


--
-- Name: deployments deployments_build_id_builds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_build_id_builds_id_fk FOREIGN KEY (build_id) REFERENCES public.builds(id) ON DELETE SET NULL;


--
-- Name: deployments deployments_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: deployments deployments_run_id_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: deployments deployments_target_id_deploy_targets_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_target_id_deploy_targets_id_fk FOREIGN KEY (target_id) REFERENCES public.deploy_targets(id) ON DELETE CASCADE;


--
-- Name: environment_deploy_locks environment_deploy_locks_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_deploy_locks
    ADD CONSTRAINT environment_deploy_locks_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: environment_deploy_locks environment_deploy_locks_locked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_deploy_locks
    ADD CONSTRAINT environment_deploy_locks_locked_by_fkey FOREIGN KEY (locked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: environment_domains environment_domains_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_domains
    ADD CONSTRAINT environment_domains_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: environment_domains environment_domains_remote_tunnel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_domains
    ADD CONSTRAINT environment_domains_remote_tunnel_id_fkey FOREIGN KEY (remote_tunnel_id) REFERENCES public.remote_tunnels(id) ON DELETE RESTRICT;


--
-- Name: environment_domains environment_domains_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_domains
    ADD CONSTRAINT environment_domains_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.cloudflare_zones(id) ON DELETE RESTRICT;


--
-- Name: environment_mailpit environment_mailpit_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_mailpit
    ADD CONSTRAINT environment_mailpit_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: environment_services environment_services_database_host_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_services
    ADD CONSTRAINT environment_services_database_host_id_fkey FOREIGN KEY (database_host_id) REFERENCES public.database_hosts(id) ON DELETE RESTRICT;


--
-- Name: environment_services environment_services_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_services
    ADD CONSTRAINT environment_services_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: environment_services environment_services_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_services
    ADD CONSTRAINT environment_services_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE RESTRICT;


--
-- Name: environment_variables environment_variables_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_variables
    ADD CONSTRAINT environment_variables_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: environment_variables environment_variables_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_variables
    ADD CONSTRAINT environment_variables_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: environments environments_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE RESTRICT;


--
-- Name: environments environments_owner_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: environments environments_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: invitations invitations_invited_by_id_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_invited_by_id_users_id_fkey FOREIGN KEY (invited_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issue_attachments issue_attachments_issue_id_issues_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_attachments
    ADD CONSTRAINT issue_attachments_issue_id_issues_id_fk FOREIGN KEY (issue_id) REFERENCES public.issues(id) ON DELETE CASCADE;


--
-- Name: issue_attachments issue_attachments_uploaded_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_attachments
    ADD CONSTRAINT issue_attachments_uploaded_by_id_users_id_fk FOREIGN KEY (uploaded_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issue_comments issue_comments_author_id_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_comments
    ADD CONSTRAINT issue_comments_author_id_users_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issue_comments issue_comments_issue_id_issues_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_comments
    ADD CONSTRAINT issue_comments_issue_id_issues_id_fkey FOREIGN KEY (issue_id) REFERENCES public.issues(id) ON DELETE CASCADE;


--
-- Name: issue_labels issue_labels_issue_id_issues_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_labels
    ADD CONSTRAINT issue_labels_issue_id_issues_id_fkey FOREIGN KEY (issue_id) REFERENCES public.issues(id) ON DELETE CASCADE;


--
-- Name: issue_labels issue_labels_label_id_labels_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_labels
    ADD CONSTRAINT issue_labels_label_id_labels_id_fkey FOREIGN KEY (label_id) REFERENCES public.labels(id) ON DELETE CASCADE;


--
-- Name: issues issues_assignee_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_assignee_id_users_id_fk FOREIGN KEY (assignee_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issues issues_created_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_created_by_id_users_id_fk FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issues issues_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE SET NULL;


--
-- Name: issues issues_milestone_id_milestones_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_milestone_id_milestones_id_fk FOREIGN KEY (milestone_id) REFERENCES public.milestones(id) ON DELETE SET NULL;


--
-- Name: issues issues_parent_id_issues_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_parent_id_issues_id_fk FOREIGN KEY (parent_id) REFERENCES public.issues(id) ON DELETE SET NULL;


--
-- Name: issues issues_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: jira_project_links jira_project_links_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_project_links
    ADD CONSTRAINT jira_project_links_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.jira_connections(id) ON DELETE CASCADE;


--
-- Name: jira_project_links jira_project_links_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_project_links
    ADD CONSTRAINT jira_project_links_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: knowledge_attachments knowledge_attachments_uploaded_by_id_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_attachments
    ADD CONSTRAINT knowledge_attachments_uploaded_by_id_users_id_fkey FOREIGN KEY (uploaded_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: knowledge_collections knowledge_collections_created_by_id_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_collections
    ADD CONSTRAINT knowledge_collections_created_by_id_users_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: knowledge_documents knowledge_documents_collection_id_knowledge_collections_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_documents
    ADD CONSTRAINT knowledge_documents_collection_id_knowledge_collections_id_fkey FOREIGN KEY (collection_id) REFERENCES public.knowledge_collections(id) ON DELETE CASCADE;


--
-- Name: knowledge_documents knowledge_documents_created_by_id_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_documents
    ADD CONSTRAINT knowledge_documents_created_by_id_users_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: knowledge_documents knowledge_documents_parent_id_knowledge_documents_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_documents
    ADD CONSTRAINT knowledge_documents_parent_id_knowledge_documents_id_fkey FOREIGN KEY (parent_id) REFERENCES public.knowledge_documents(id) ON DELETE SET NULL;


--
-- Name: knowledge_documents knowledge_documents_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_documents
    ADD CONSTRAINT knowledge_documents_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: knowledge_documents knowledge_documents_updated_by_id_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_documents
    ADD CONSTRAINT knowledge_documents_updated_by_id_users_id_fkey FOREIGN KEY (updated_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: knowledge_links knowledge_links_from_document_id_knowledge_documents_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_links
    ADD CONSTRAINT knowledge_links_from_document_id_knowledge_documents_id_fkey FOREIGN KEY (from_document_id) REFERENCES public.knowledge_documents(id) ON DELETE CASCADE;


--
-- Name: knowledge_links knowledge_links_to_document_id_knowledge_documents_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_links
    ADD CONSTRAINT knowledge_links_to_document_id_knowledge_documents_id_fkey FOREIGN KEY (to_document_id) REFERENCES public.knowledge_documents(id) ON DELETE CASCADE;


--
-- Name: knowledge_revisions knowledge_revisions_document_id_knowledge_documents_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_revisions
    ADD CONSTRAINT knowledge_revisions_document_id_knowledge_documents_id_fkey FOREIGN KEY (document_id) REFERENCES public.knowledge_documents(id) ON DELETE CASCADE;


--
-- Name: knowledge_revisions knowledge_revisions_edited_by_id_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_revisions
    ADD CONSTRAINT knowledge_revisions_edited_by_id_users_id_fkey FOREIGN KEY (edited_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: milestones milestones_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.milestones
    ADD CONSTRAINT milestones_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_users_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: passkeys passkeys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passkeys
    ADD CONSTRAINT passkeys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: environment_access project_access_project_id_projects_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_access
    ADD CONSTRAINT project_access_project_id_projects_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: environment_access project_access_user_id_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_access
    ADD CONSTRAINT project_access_user_id_users_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: project_members project_members_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_members project_members_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: projects projects_default_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_default_server_id_fkey FOREIGN KEY (default_server_id) REFERENCES public.servers(id) ON DELETE SET NULL;


--
-- Name: provisioning_steps provisioning_steps_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioning_steps
    ADD CONSTRAINT provisioning_steps_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: provisioning_steps provisioning_steps_last_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioning_steps
    ADD CONSTRAINT provisioning_steps_last_run_id_fkey FOREIGN KEY (last_run_id) REFERENCES public.runs(id) ON DELETE SET NULL;


--
-- Name: remote_tunnels remote_tunnels_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_tunnels
    ADD CONSTRAINT remote_tunnels_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.cloudflare_accounts(id) ON DELETE RESTRICT;


--
-- Name: remote_tunnels remote_tunnels_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_tunnels
    ADD CONSTRAINT remote_tunnels_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE RESTRICT;


--
-- Name: runs runs_acknowledged_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_acknowledged_by_id_users_id_fk FOREIGN KEY (acknowledged_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: runs runs_issue_id_issues_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_issue_id_issues_id_fk FOREIGN KEY (issue_id) REFERENCES public.issues(id) ON DELETE SET NULL;


--
-- Name: saved_views saved_views_user_id_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_views
    ADD CONSTRAINT saved_views_user_id_users_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_impersonated_by_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_impersonated_by_users_id_fkey FOREIGN KEY (impersonated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_user_id_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: runs tasks_project_id_projects_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT tasks_project_id_projects_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: runs tasks_user_id_users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT tasks_user_id_users_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: tunnels tunnels_server_id_servers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tunnels
    ADD CONSTRAINT tunnels_server_id_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE RESTRICT;


--
-- Name: tunnels tunnels_zone_id_cloudflare_zones_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tunnels
    ADD CONSTRAINT tunnels_zone_id_cloudflare_zones_id_fk FOREIGN KEY (zone_id) REFERENCES public.cloudflare_zones(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict j0kcJyNFdT4DwfqPwzo80S2VoVl0werNsobBRRv7Ch1Fi2HgBaD1jzyXrwJniqM

