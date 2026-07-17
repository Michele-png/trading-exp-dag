-- Foundational multi-tenant schema for the experiment DAG.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

create type public.workspace_kind as enum ('personal', 'team');
create type public.workspace_member_role as enum ('owner', 'admin', 'member', 'viewer');
create type public.node_kind as enum ('objective', 'experiment');
create type public.revision_state as enum ('draft', 'finalized');
create type public.experiment_operational_state as enum (
  'planned',
  'ready',
  'running',
  'completed',
  'failed',
  'cancelled'
);
create type public.experiment_conclusion_state as enum (
  'pending',
  'supported',
  'refuted',
  'mixed',
  'inconclusive'
);
create type public.lineage_link_kind as enum ('derived_from', 'synthesizes');
create type public.semantic_link_kind as enum (
  'supports',
  'contradicts',
  'replicates'
);
create type public.run_status as enum (
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled'
);
create type public.metric_direction as enum ('maximize', 'minimize', 'neutral');

create table public.workspaces (
  id uuid primary key default extensions.gen_random_uuid(),
  kind public.workspace_kind not null default 'team',
  name text not null check (btrim(name) <> ''),
  slug text not null unique
    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  personal_owner_user_id uuid references auth.users (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  archived_at timestamptz,
  constraint workspaces_personal_owner_check check (
    (kind = 'personal' and personal_owner_user_id is not null)
    or (kind = 'team' and personal_owner_user_id is null)
  )
);

create unique index workspaces_personal_owner_uidx
  on public.workspaces (personal_owner_user_id)
  where personal_owner_user_id is not null;
create index workspaces_created_by_idx on public.workspaces (created_by);
create index workspaces_archived_at_idx
  on public.workspaces (archived_at)
  where archived_at is not null;

create table public.workspace_members (
  workspace_id uuid not null
    references public.workspaces (id) on delete cascade,
  user_id uuid not null
    references auth.users (id) on delete cascade,
  role public.workspace_member_role not null default 'member',
  invited_by uuid references auth.users (id) on delete set null,
  joined_at timestamptz not null default statement_timestamp(),
  removed_at timestamptz,
  primary key (workspace_id, user_id)
);

create index workspace_members_user_id_idx
  on public.workspace_members (user_id, workspace_id)
  where removed_at is null;
create index workspace_members_invited_by_idx
  on public.workspace_members (invited_by);
create index workspace_members_active_workspace_role_idx
  on public.workspace_members (workspace_id, role)
  where removed_at is null;

create table public.spaces (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null
    references public.workspaces (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  slug text not null
    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  description text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  archived_at timestamptz,
  unique (workspace_id, slug),
  unique (workspace_id, id)
);

create index spaces_workspace_id_idx on public.spaces (workspace_id);
create index spaces_created_by_idx on public.spaces (created_by);
create index spaces_archived_at_idx
  on public.spaces (workspace_id, archived_at)
  where archived_at is not null;

create table public.nodes (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null
    references public.spaces (id) on delete cascade,
  kind public.node_kind not null,
  current_revision_id uuid,
  finalized_at timestamptz,
  archived_at timestamptz,
  tombstoned_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (space_id, id),
  constraint nodes_tombstone_check check (
    tombstoned_at is null or archived_at is not null
  )
);

create unique index nodes_one_objective_per_space_uidx
  on public.nodes (space_id)
  where kind = 'objective';
create index nodes_space_kind_idx on public.nodes (space_id, kind);
create index nodes_current_revision_id_idx
  on public.nodes (current_revision_id)
  where current_revision_id is not null;
create index nodes_current_revision_fk_idx
  on public.nodes (space_id, id, current_revision_id)
  where current_revision_id is not null;
create index nodes_created_by_idx on public.nodes (created_by);
create index nodes_active_space_idx
  on public.nodes (space_id, created_at)
  where archived_at is null and tombstoned_at is null;

create table public.node_revisions (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null,
  node_id uuid not null,
  revision_number bigint not null,
  state public.revision_state not null default 'draft',
  title text not null check (btrim(title) <> ''),
  hypothesis text,
  method text,
  conclusion text,
  operational_state public.experiment_operational_state,
  conclusion_state public.experiment_conclusion_state,
  preregistered_at timestamptz,
  retrospective boolean not null default false,
  change_summary text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_by uuid references auth.users (id) on delete set null,
  finalized_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  finalized_at timestamptz,
  archived_at timestamptz,
  tombstoned_at timestamptz,
  search_document tsvector generated always as (
    setweight(
      to_tsvector('english'::regconfig, coalesce(title, '')),
      'A'
    )
    || setweight(
      to_tsvector('english'::regconfig, coalesce(hypothesis, '')),
      'A'
    )
    || setweight(
      to_tsvector('english'::regconfig, coalesce(method, '')),
      'B'
    )
    || setweight(
      to_tsvector('english'::regconfig, coalesce(conclusion, '')),
      'B'
    )
  ) stored,
  constraint node_revisions_node_fk
    foreign key (space_id, node_id)
    references public.nodes (space_id, id)
    on delete cascade,
  constraint node_revisions_state_timestamps_check check (
    (
      state = 'draft'
      and finalized_at is null
      and finalized_by is null
    )
    or (
      state = 'finalized'
      and finalized_at is not null
      and finalized_by is not null
    )
  ),
  constraint node_revisions_tombstone_check check (
    tombstoned_at is null or archived_at is not null
  ),
  unique (node_id, revision_number),
  unique (space_id, id),
  unique (space_id, node_id, id)
);

create unique index node_revisions_one_draft_per_node_uidx
  on public.node_revisions (node_id)
  where state = 'draft';
create index node_revisions_space_node_idx
  on public.node_revisions (space_id, node_id);
create index node_revisions_created_by_idx
  on public.node_revisions (created_by);
create index node_revisions_finalized_by_idx
  on public.node_revisions (finalized_by);
create index node_revisions_state_idx
  on public.node_revisions (space_id, state, created_at desc);
create index node_revisions_search_document_idx
  on public.node_revisions using gin (search_document);

alter table public.nodes
  add constraint nodes_current_revision_fk
  foreign key (space_id, id, current_revision_id)
  references public.node_revisions (space_id, node_id, id)
  deferrable initially deferred;

create table public.node_lineage (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null,
  parent_node_id uuid not null,
  child_node_id uuid not null,
  kind public.lineage_link_kind not null default 'derived_from',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  constraint node_lineage_parent_fk
    foreign key (space_id, parent_node_id)
    references public.nodes (space_id, id)
    on delete cascade,
  constraint node_lineage_child_fk
    foreign key (space_id, child_node_id)
    references public.nodes (space_id, id)
    on delete cascade,
  constraint node_lineage_no_self_check
    check (parent_node_id <> child_node_id),
  unique (space_id, parent_node_id, child_node_id)
);

create index node_lineage_space_parent_idx
  on public.node_lineage (space_id, parent_node_id);
create index node_lineage_space_child_idx
  on public.node_lineage (space_id, child_node_id);
create index node_lineage_space_kind_idx
  on public.node_lineage (space_id, kind, created_at desc);
create index node_lineage_parent_node_id_idx
  on public.node_lineage (parent_node_id);
create index node_lineage_child_node_id_idx
  on public.node_lineage (child_node_id);
create index node_lineage_created_by_idx
  on public.node_lineage (created_by);

create table public.semantic_links (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null,
  source_node_id uuid not null,
  target_node_id uuid not null,
  target_revision_id uuid not null,
  kind public.semantic_link_kind not null,
  rationale text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  archived_at timestamptz,
  constraint semantic_links_source_fk
    foreign key (space_id, source_node_id)
    references public.nodes (space_id, id)
    on delete cascade,
  constraint semantic_links_target_revision_fk
    foreign key (space_id, target_node_id, target_revision_id)
    references public.node_revisions (space_id, node_id, id)
    on delete restrict,
  constraint semantic_links_no_self_check
    check (source_node_id <> target_node_id),
  unique (
    space_id,
    source_node_id,
    target_node_id,
    target_revision_id,
    kind
  )
);

create index semantic_links_space_source_idx
  on public.semantic_links (space_id, source_node_id);
create index semantic_links_space_target_idx
  on public.semantic_links (space_id, target_node_id);
create index semantic_links_target_revision_id_idx
  on public.semantic_links (target_revision_id);
create index semantic_links_target_revision_fk_idx
  on public.semantic_links (space_id, target_node_id, target_revision_id);
create index semantic_links_created_by_idx
  on public.semantic_links (created_by);
create index semantic_links_active_kind_idx
  on public.semantic_links (space_id, kind, created_at desc)
  where archived_at is null;

create table public.runs (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null,
  experiment_node_id uuid not null,
  revision_id uuid not null,
  status public.run_status not null default 'queued',
  command text,
  environment jsonb not null default '{}'::jsonb
    check (jsonb_typeof(environment) = 'object'),
  parameters jsonb not null default '{}'::jsonb
    check (jsonb_typeof(parameters) = 'object'),
  result_manifest_version text,
  result_manifest jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result_manifest) = 'object'),
  narrative text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  started_at timestamptz,
  finished_at timestamptz,
  exit_code integer,
  error_message text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  archived_at timestamptz,
  tombstoned_at timestamptz,
  constraint runs_revision_fk
    foreign key (space_id, experiment_node_id, revision_id)
    references public.node_revisions (space_id, node_id, id)
    on delete restrict,
  constraint runs_timestamps_check check (
    finished_at is null or started_at is not null
  ),
  constraint runs_tombstone_check check (
    tombstoned_at is null or archived_at is not null
  ),
  unique (space_id, id)
);

create index runs_space_id_idx on public.runs (space_id);
create index runs_experiment_revision_idx
  on public.runs (space_id, experiment_node_id, revision_id);
create index runs_revision_id_idx on public.runs (revision_id);
create index runs_created_by_idx on public.runs (created_by);
create index runs_status_idx
  on public.runs (space_id, status, created_at desc);

create table public.metric_definitions (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null
    references public.spaces (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  description text,
  unit text,
  direction public.metric_direction not null default 'neutral',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  archived_at timestamptz,
  unique (space_id, id)
);

create unique index metric_definitions_space_name_uidx
  on public.metric_definitions (space_id, lower(name));
create index metric_definitions_space_id_idx
  on public.metric_definitions (space_id);
create index metric_definitions_created_by_idx
  on public.metric_definitions (created_by);

create table public.metric_observations (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null,
  run_id uuid not null,
  metric_definition_id uuid not null,
  value double precision not null check (
    value not in (
      'Infinity'::double precision,
      '-Infinity'::double precision,
      'NaN'::double precision
    )
  ),
  step bigint check (step is null or step >= 0),
  observed_at timestamptz not null default statement_timestamp(),
  dimensions jsonb not null default '{}'::jsonb
    check (jsonb_typeof(dimensions) = 'object'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  archived_at timestamptz,
  tombstoned_at timestamptz,
  constraint metric_observations_run_fk
    foreign key (space_id, run_id)
    references public.runs (space_id, id)
    on delete cascade,
  constraint metric_observations_definition_fk
    foreign key (space_id, metric_definition_id)
    references public.metric_definitions (space_id, id)
    on delete restrict,
  constraint metric_observations_tombstone_check check (
    tombstoned_at is null or archived_at is not null
  )
);

create index metric_observations_space_id_idx
  on public.metric_observations (space_id);
create index metric_observations_run_id_idx
  on public.metric_observations (run_id, observed_at);
create index metric_observations_metric_definition_id_idx
  on public.metric_observations (metric_definition_id, observed_at);
create index metric_observations_run_fk_idx
  on public.metric_observations (space_id, run_id);
create index metric_observations_definition_fk_idx
  on public.metric_observations (space_id, metric_definition_id);
create index metric_observations_created_by_idx
  on public.metric_observations (created_by);

create table public.code_references (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null,
  node_revision_id uuid,
  run_id uuid,
  repository_uri text not null check (btrim(repository_uri) <> ''),
  commit_sha text not null check (btrim(commit_sha) <> ''),
  path text,
  content_hash text,
  dirty boolean not null default false,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  archived_at timestamptz,
  constraint code_references_owner_check check (
    num_nonnulls(node_revision_id, run_id) = 1
  ),
  constraint code_references_revision_fk
    foreign key (space_id, node_revision_id)
    references public.node_revisions (space_id, id)
    on delete cascade,
  constraint code_references_run_fk
    foreign key (space_id, run_id)
    references public.runs (space_id, id)
    on delete cascade
);

create index code_references_space_id_idx on public.code_references (space_id);
create index code_references_node_revision_id_idx
  on public.code_references (node_revision_id);
create index code_references_run_id_idx on public.code_references (run_id);
create index code_references_revision_fk_idx
  on public.code_references (space_id, node_revision_id);
create index code_references_run_fk_idx
  on public.code_references (space_id, run_id);
create index code_references_created_by_idx
  on public.code_references (created_by);
create index code_references_repository_commit_idx
  on public.code_references (repository_uri, commit_sha);

create table public.data_references (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null,
  node_revision_id uuid,
  run_id uuid,
  uri text not null check (btrim(uri) <> ''),
  version text not null check (btrim(version) <> ''),
  checksum_algorithm text not null default 'sha256',
  checksum text not null check (btrim(checksum) <> ''),
  schema_fingerprint text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  archived_at timestamptz,
  constraint data_references_owner_check check (
    num_nonnulls(node_revision_id, run_id) = 1
  ),
  constraint data_references_revision_fk
    foreign key (space_id, node_revision_id)
    references public.node_revisions (space_id, id)
    on delete cascade,
  constraint data_references_run_fk
    foreign key (space_id, run_id)
    references public.runs (space_id, id)
    on delete cascade
);

create index data_references_space_id_idx on public.data_references (space_id);
create index data_references_node_revision_id_idx
  on public.data_references (node_revision_id);
create index data_references_run_id_idx on public.data_references (run_id);
create index data_references_revision_fk_idx
  on public.data_references (space_id, node_revision_id);
create index data_references_run_fk_idx
  on public.data_references (space_id, run_id);
create index data_references_created_by_idx
  on public.data_references (created_by);
create index data_references_uri_version_idx
  on public.data_references (uri, version);

create table public.artifacts (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null,
  node_revision_id uuid,
  run_id uuid,
  name text not null check (btrim(name) <> ''),
  media_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  checksum_algorithm text not null default 'sha256',
  checksum text not null check (btrim(checksum) <> ''),
  storage_path text,
  external_uri text,
  owner_user_id uuid references auth.users (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  archived_at timestamptz,
  tombstoned_at timestamptz,
  constraint artifacts_owner_check check (
    num_nonnulls(node_revision_id, run_id) = 1
  ),
  constraint artifacts_location_check check (
    num_nonnulls(storage_path, external_uri) = 1
  ),
  constraint artifacts_storage_path_check check (
    storage_path is null
    or (
      storage_path !~ '(^/|(?:^|/)\.\.(?:/|$))'
      and btrim(storage_path) <> ''
      and storage_path like space_id::text || '/' || id::text || '/%'
    )
  ),
  constraint artifacts_revision_fk
    foreign key (space_id, node_revision_id)
    references public.node_revisions (space_id, id)
    on delete cascade,
  constraint artifacts_run_fk
    foreign key (space_id, run_id)
    references public.runs (space_id, id)
    on delete cascade,
  constraint artifacts_tombstone_check check (
    tombstoned_at is null or archived_at is not null
  )
);

create unique index artifacts_storage_path_uidx
  on public.artifacts (storage_path)
  where storage_path is not null;
create index artifacts_space_id_idx on public.artifacts (space_id);
create index artifacts_node_revision_id_idx
  on public.artifacts (node_revision_id);
create index artifacts_run_id_idx on public.artifacts (run_id);
create index artifacts_revision_fk_idx
  on public.artifacts (space_id, node_revision_id);
create index artifacts_run_fk_idx
  on public.artifacts (space_id, run_id);
create index artifacts_owner_user_id_idx on public.artifacts (owner_user_id);
create index artifacts_created_by_idx on public.artifacts (created_by);
create index artifacts_external_uri_idx
  on public.artifacts (external_uri)
  where external_uri is not null;

create table public.api_tokens (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null
    references public.workspaces (id) on delete cascade,
  user_id uuid not null
    references auth.users (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  token_hash bytea not null unique
    check (octet_length(token_hash) >= 32),
  scopes text[] not null check (cardinality(scopes) > 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint api_tokens_expiry_check check (
    expires_at is null or expires_at > created_at
  )
);

create index api_tokens_workspace_id_idx on public.api_tokens (workspace_id);
create index api_tokens_user_id_idx on public.api_tokens (user_id);
create index api_tokens_active_expiry_idx
  on public.api_tokens (expires_at)
  where revoked_at is null;
create index api_tokens_last_used_at_idx
  on public.api_tokens (last_used_at desc);

create table public.idempotency_keys (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null
    references public.workspaces (id) on delete cascade,
  api_token_id uuid
    references public.api_tokens (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  key text not null check (btrim(key) <> ''),
  request_hash bytea not null check (octet_length(request_hash) >= 16),
  response_status integer
    check (response_status is null or response_status between 100 and 599),
  response_body jsonb,
  locked_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint idempotency_keys_completion_check check (
    (completed_at is null and response_status is null)
    or (completed_at is not null and response_status is not null)
  ),
  constraint idempotency_keys_expiry_check check (expires_at > created_at),
  unique (workspace_id, key)
);

create index idempotency_keys_workspace_id_idx
  on public.idempotency_keys (workspace_id);
create index idempotency_keys_api_token_id_idx
  on public.idempotency_keys (api_token_id);
create index idempotency_keys_created_by_idx
  on public.idempotency_keys (created_by);
create index idempotency_keys_expires_at_idx
  on public.idempotency_keys (expires_at);

create table public.audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null
    references public.workspaces (id) on delete cascade,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_api_token_id uuid
    references public.api_tokens (id) on delete set null,
  action text not null check (btrim(action) <> ''),
  resource_type text not null check (btrim(resource_type) <> ''),
  resource_id uuid,
  request_id uuid,
  idempotency_key_id uuid
    references public.idempotency_keys (id) on delete set null,
  details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz not null default clock_timestamp(),
  constraint audit_events_actor_check check (
    num_nonnulls(actor_user_id, actor_api_token_id) <= 1
  )
);

create index audit_events_workspace_occurred_at_idx
  on public.audit_events (workspace_id, occurred_at desc);
create index audit_events_actor_user_id_idx
  on public.audit_events (actor_user_id);
create index audit_events_actor_api_token_id_idx
  on public.audit_events (actor_api_token_id);
create index audit_events_idempotency_key_id_idx
  on public.audit_events (idempotency_key_id);
create index audit_events_resource_idx
  on public.audit_events (workspace_id, resource_type, resource_id);
create index audit_events_request_id_idx
  on public.audit_events (request_id)
  where request_id is not null;
