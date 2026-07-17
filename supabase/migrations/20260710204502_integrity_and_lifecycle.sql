-- Transaction-safe DAG, revision, and record-lifecycle invariants.

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := statement_timestamp();
  return new;
end;
$$;

create or replace function private.lock_space(p_space_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_space_id::text, 724153::bigint)
  );
$$;

create or replace function private.is_node_root_reachable(p_node_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive ancestors (node_id) as (
    select p_node_id
    union
    select lineage.parent_node_id
    from public.node_lineage as lineage
    join ancestors
      on ancestors.node_id = lineage.child_node_id
  )
  select exists (
    select 1
    from ancestors
    join public.nodes
      on nodes.id = ancestors.node_id
    where nodes.kind = 'objective'::public.node_kind
      and nodes.space_id = (
        select origin.space_id
        from public.nodes as origin
        where origin.id = p_node_id
      )
  );
$$;

create or replace function private.assert_finalized_nodes_reachable(
  p_space_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unreachable_node_id uuid;
begin
  select nodes.id
  into v_unreachable_node_id
  from public.nodes
  where nodes.space_id = p_space_id
    and nodes.kind = 'experiment'::public.node_kind
    and nodes.finalized_at is not null
    and not private.is_node_root_reachable(nodes.id)
  limit 1;

  if v_unreachable_node_id is not null then
    raise exception
      'finalized experiment % must remain reachable from its space objective',
      v_unreachable_node_id
      using errcode = '23514';
  end if;
end;
$$;

create or replace function private.ensure_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is not null then
    insert into public.workspace_members (
      workspace_id,
      user_id,
      role,
      invited_by,
      removed_at
    )
    values (
      new.id,
      new.created_by,
      'owner'::public.workspace_member_role,
      new.created_by,
      null
    )
    on conflict (workspace_id, user_id)
    do update
      set role = 'owner'::public.workspace_member_role,
          removed_at = null;
  end if;

  return new;
end;
$$;

create trigger workspaces_20_ensure_owner
after insert on public.workspaces
for each row execute function private.ensure_workspace_owner();

create or replace function private.enforce_workspace_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.kind is distinct from old.kind
    or new.personal_owner_user_id is distinct from old.personal_owner_user_id
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  then
    raise exception 'workspace identity fields are immutable'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger workspaces_10_enforce_identity
before update on public.workspaces
for each row execute function private.enforce_workspace_identity();

create or replace function private.provision_personal_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text;
begin
  v_display_name := coalesce(
    nullif(pg_catalog.split_part(coalesce(new.email, ''), '@', 1), ''),
    'Personal'
  );

  insert into public.workspaces (
    kind,
    name,
    slug,
    personal_owner_user_id,
    created_by
  )
  values (
    'personal'::public.workspace_kind,
    v_display_name || '''s workspace',
    'personal-' || pg_catalog.replace(new.id::text, '-', ''),
    new.id,
    new.id
  )
  on conflict (personal_owner_user_id)
    where personal_owner_user_id is not null
  do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created_provision_workspace
after insert on auth.users
for each row execute function private.provision_personal_workspace();

create or replace function private.create_space_objective()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.nodes (space_id, kind, created_by)
  values (new.id, 'objective'::public.node_kind, new.created_by);

  return new;
end;
$$;

create trigger spaces_20_create_objective
after insert on public.spaces
for each row execute function private.create_space_objective();

create or replace function private.enforce_node_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_latest_revision_id uuid;
begin
  if tg_op = 'DELETE' then
    perform private.lock_space(old.space_id);

    if old.kind = 'objective'::public.node_kind then
      raise exception 'a space objective cannot be deleted'
        using errcode = '23514';
    end if;

    if old.finalized_at is not null then
      raise exception 'finalized nodes may only be archived or tombstoned'
        using errcode = '55000';
    end if;

    return old;
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.space_id is distinct from old.space_id
      or new.kind is distinct from old.kind
      or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
    then
      raise exception 'node identity fields are immutable'
        using errcode = '55000';
    end if;

    if new.current_revision_id is distinct from old.current_revision_id then
      select node_revisions.id
      into v_latest_revision_id
      from public.node_revisions
      where node_revisions.node_id = old.id
      order by node_revisions.revision_number desc
      limit 1;

      if new.current_revision_id is distinct from v_latest_revision_id then
        raise exception 'current revision must be the latest appended revision'
          using errcode = '23514';
      end if;
    end if;

    if old.finalized_at is not null then
      if new.finalized_at is distinct from old.finalized_at then
        raise exception 'node finalization metadata is immutable'
          using errcode = '55000';
      end if;
    elsif new.finalized_at is distinct from old.finalized_at then
      if new.finalized_at is null
        or not exists (
          select 1
          from public.node_revisions
          where node_revisions.node_id = old.id
            and node_revisions.state = 'finalized'::public.revision_state
        )
      then
        raise exception 'a node is finalized only by finalizing its revision'
          using errcode = '55000';
      end if;
    end if;

    new.updated_at := statement_timestamp();
  end if;

  return new;
end;
$$;

create trigger nodes_10_enforce_lifecycle
before update or delete on public.nodes
for each row execute function private.enforce_node_lifecycle();

create or replace function private.prepare_node_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_node_kind public.node_kind;
  v_next_revision bigint;
begin
  select nodes.kind
  into v_node_kind
  from public.nodes
  where nodes.space_id = new.space_id
    and nodes.id = new.node_id
    and nodes.archived_at is null
    and nodes.tombstoned_at is null
  for update;

  if not found then
    raise exception 'revision node must exist and be active in the same space'
      using errcode = '23503';
  end if;

  select coalesce(max(node_revisions.revision_number), 0) + 1
  into v_next_revision
  from public.node_revisions
  where node_revisions.node_id = new.node_id;

  if new.revision_number is null then
    new.revision_number := v_next_revision;
  elsif new.revision_number <> v_next_revision then
    raise exception 'revision number must append at %', v_next_revision
      using errcode = '23514';
  end if;

  if new.state <> 'draft'::public.revision_state
    or new.finalized_at is not null
    or new.finalized_by is not null
  then
    raise exception 'new revisions must start as drafts'
      using errcode = '23514';
  end if;

  new.archived_at := null;
  new.tombstoned_at := null;

  if v_node_kind = 'objective'::public.node_kind then
    if new.hypothesis is not null
      or new.method is not null
      or new.conclusion is not null
      or new.operational_state is not null
      or new.conclusion_state is not null
      or new.preregistered_at is not null
      or new.retrospective
    then
      raise exception 'objective revisions cannot contain experiment fields'
        using errcode = '23514';
    end if;
  else
    new.operational_state := coalesce(
      new.operational_state,
      'planned'::public.experiment_operational_state
    );
    new.conclusion_state := coalesce(
      new.conclusion_state,
      'pending'::public.experiment_conclusion_state
    );
  end if;

  return new;
end;
$$;

create trigger node_revisions_10_prepare
before insert on public.node_revisions
for each row execute function private.prepare_node_revision();

create or replace function private.set_current_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.nodes
  set current_revision_id = new.id
  where id = new.node_id
    and space_id = new.space_id;

  return new;
end;
$$;

create trigger node_revisions_30_set_current
after insert on public.node_revisions
for each row execute function private.set_current_revision();

create or replace function private.enforce_revision_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_node public.nodes%rowtype;
begin
  if tg_op = 'DELETE' then
    if old.state = 'finalized'::public.revision_state then
      raise exception 'finalized revisions cannot be deleted'
        using errcode = '55000';
    end if;

    return old;
  end if;

  if new.id is distinct from old.id
    or new.space_id is distinct from old.space_id
    or new.node_id is distinct from old.node_id
    or new.revision_number is distinct from old.revision_number
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  then
    raise exception 'revision identity fields are immutable'
      using errcode = '55000';
  end if;

  if old.state = 'finalized'::public.revision_state then
    if new.state is distinct from old.state
      or new.title is distinct from old.title
      or new.hypothesis is distinct from old.hypothesis
      or new.method is distinct from old.method
      or new.conclusion is distinct from old.conclusion
      or new.operational_state is distinct from old.operational_state
      or new.conclusion_state is distinct from old.conclusion_state
      or new.preregistered_at is distinct from old.preregistered_at
      or new.retrospective is distinct from old.retrospective
      or new.change_summary is distinct from old.change_summary
      or new.metadata is distinct from old.metadata
      or new.finalized_by is distinct from old.finalized_by
      or new.finalized_at is distinct from old.finalized_at
    then
      raise exception
        'finalized revisions may only be archived or tombstoned'
        using errcode = '55000';
    end if;

    new.updated_at := statement_timestamp();
    return new;
  end if;

  if new.archived_at is not null or new.tombstoned_at is not null then
    raise exception 'draft revisions are deleted rather than archived'
      using errcode = '23514';
  end if;

  select nodes.*
  into v_node
  from public.nodes
  where nodes.id = old.node_id
    and nodes.space_id = old.space_id
  for update;

  if v_node.kind = 'objective'::public.node_kind then
    if new.hypothesis is not null
      or new.method is not null
      or new.conclusion is not null
      or new.operational_state is not null
      or new.conclusion_state is not null
      or new.preregistered_at is not null
      or new.retrospective
    then
      raise exception 'objective revisions cannot contain experiment fields'
        using errcode = '23514';
    end if;
  elsif new.operational_state is null or new.conclusion_state is null then
    raise exception
      'experiment operational and conclusion states are both required'
      using errcode = '23514';
  end if;

  if new.state = 'finalized'::public.revision_state then
    perform private.lock_space(old.space_id);

    if v_node.current_revision_id <> old.id then
      raise exception 'only the current draft revision can be finalized'
        using errcode = '23514';
    end if;

    if v_node.kind = 'experiment'::public.node_kind
      and not private.is_node_root_reachable(old.node_id)
    then
      raise exception
        'experiment % must be objective-root-reachable before finalization',
        old.node_id
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from public.runs
      where runs.space_id = old.space_id
        and runs.experiment_node_id = old.node_id
        and runs.revision_id = old.id
        and runs.status in (
          'queued'::public.run_status,
          'running'::public.run_status
        )
    ) then
      raise exception 'an experiment cannot be finalized while runs are active'
        using errcode = '23514';
    end if;

    new.finalized_at := statement_timestamp();
    new.finalized_by := coalesce(
      (select auth.uid()),
      old.created_by
    );

    if new.finalized_by is null then
      raise exception 'a finalized revision requires an actor'
        using errcode = '23502';
    end if;
  elsif new.finalized_at is not null or new.finalized_by is not null then
    raise exception 'draft revisions cannot have finalization metadata'
      using errcode = '23514';
  end if;

  new.updated_at := statement_timestamp();
  return new;
end;
$$;

create trigger node_revisions_20_enforce_lifecycle
before update or delete on public.node_revisions
for each row execute function private.enforce_revision_lifecycle();

create or replace function private.restore_current_revision_after_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.nodes
  set current_revision_id = (
    select node_revisions.id
    from public.node_revisions
    where node_revisions.node_id = old.node_id
    order by node_revisions.revision_number desc
    limit 1
  )
  where id = old.node_id
    and current_revision_id = old.id;

  return old;
end;
$$;

create trigger node_revisions_30_restore_current_after_delete
after delete on public.node_revisions
for each row execute function private.restore_current_revision_after_delete();

create or replace function private.mark_node_finalized()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.state = 'draft'::public.revision_state
    and new.state = 'finalized'::public.revision_state
  then
    update public.nodes
    set finalized_at = coalesce(finalized_at, new.finalized_at)
    where id = new.node_id
      and space_id = new.space_id;
  end if;

  return new;
end;
$$;

create trigger node_revisions_40_mark_node_finalized
after update of state on public.node_revisions
for each row execute function private.mark_node_finalized();

create or replace function private.enforce_lineage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_kind public.node_kind;
  v_child_kind public.node_kind;
  v_existing_edge_id uuid;
begin
  if tg_op = 'DELETE' then
    perform private.lock_space(old.space_id);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    v_existing_edge_id := old.id;

    if new.id is distinct from old.id
      or new.space_id is distinct from old.space_id
      or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
    then
      raise exception 'lineage identity fields are immutable'
        using errcode = '55000';
    end if;
  end if;

  perform private.lock_space(new.space_id);

  select nodes.kind
  into v_parent_kind
  from public.nodes
  where nodes.space_id = new.space_id
    and nodes.id = new.parent_node_id;

  if not found then
    raise exception 'lineage parent must belong to the edge space'
      using errcode = '23503';
  end if;

  select nodes.kind
  into v_child_kind
  from public.nodes
  where nodes.space_id = new.space_id
    and nodes.id = new.child_node_id;

  if not found then
    raise exception 'lineage child must belong to the edge space'
      using errcode = '23503';
  end if;

  if v_child_kind <> 'experiment'::public.node_kind then
    raise exception 'an objective cannot have a lineage parent'
      using errcode = '23514';
  end if;

  if new.parent_node_id = new.child_node_id then
    raise exception 'a node cannot be its own lineage parent'
      using errcode = '23514';
  end if;

  if exists (
    with recursive descendants (node_id) as (
      select new.child_node_id
      union
      select lineage.child_node_id
      from public.node_lineage as lineage
      join descendants
        on descendants.node_id = lineage.parent_node_id
      where lineage.id is distinct from v_existing_edge_id
    )
    select 1
    from descendants
    where descendants.node_id = new.parent_node_id
  ) then
    raise exception 'lineage edge would create a cycle'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger node_lineage_10_enforce
before insert or update or delete on public.node_lineage
for each row execute function private.enforce_lineage();

create or replace function private.check_reachability_after_lineage_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_finalized_nodes_reachable(
    case when tg_op = 'DELETE' then old.space_id else new.space_id end
  );

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create trigger node_lineage_30_check_reachability
after update or delete on public.node_lineage
for each row execute function private.check_reachability_after_lineage_change();

create or replace function private.validate_semantic_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.nodes
    where nodes.space_id = new.space_id
      and nodes.id = new.source_node_id
      and nodes.kind = 'experiment'::public.node_kind
  ) then
    raise exception 'semantic link source must be a same-space experiment'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.node_revisions
    join public.nodes
      on nodes.id = node_revisions.node_id
     and nodes.space_id = node_revisions.space_id
    where node_revisions.space_id = new.space_id
      and node_revisions.node_id = new.target_node_id
      and node_revisions.id = new.target_revision_id
      and node_revisions.state = 'finalized'::public.revision_state
      and nodes.kind = 'experiment'::public.node_kind
  ) then
    raise exception
      'semantic link target must be a finalized same-space experiment revision'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger semantic_links_10_validate
before insert or update on public.semantic_links
for each row execute function private.validate_semantic_link();

create or replace function private.validate_run_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.node_revisions
    join public.nodes
      on nodes.id = node_revisions.node_id
     and nodes.space_id = node_revisions.space_id
    where node_revisions.space_id = new.space_id
      and node_revisions.node_id = new.experiment_node_id
      and node_revisions.id = new.revision_id
      and node_revisions.state = 'draft'::public.revision_state
      and nodes.kind = 'experiment'::public.node_kind
      and nodes.current_revision_id = node_revisions.id
      and nodes.finalized_at is null
  ) then
    raise exception 'runs require the current draft experiment revision'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger runs_10_validate_revision
before insert on public.runs
for each row execute function private.validate_run_revision();

create or replace function private.enforce_run_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_terminal boolean;
  v_new_terminal boolean;
begin
  if tg_op = 'DELETE' then
    if old.status in (
      'succeeded'::public.run_status,
      'failed'::public.run_status,
      'cancelled'::public.run_status
    ) then
      raise exception 'terminal runs may only be archived or tombstoned'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if new.id is distinct from old.id
    or new.space_id is distinct from old.space_id
    or new.experiment_node_id is distinct from old.experiment_node_id
    or new.revision_id is distinct from old.revision_id
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  then
    raise exception 'run identity fields are immutable'
      using errcode = '55000';
  end if;

  v_old_terminal := old.status in (
    'succeeded'::public.run_status,
    'failed'::public.run_status,
    'cancelled'::public.run_status
  );
  v_new_terminal := new.status in (
    'succeeded'::public.run_status,
    'failed'::public.run_status,
    'cancelled'::public.run_status
  );

  if v_old_terminal then
    if (to_jsonb(new) - array['updated_at', 'archived_at', 'tombstoned_at'])
      is distinct from
      (to_jsonb(old) - array['updated_at', 'archived_at', 'tombstoned_at'])
    then
      raise exception 'terminal runs may only be archived or tombstoned'
        using errcode = '55000';
    end if;
  else
    if old.status = 'running'::public.run_status
      and new.status = 'queued'::public.run_status
    then
      raise exception 'a running run cannot return to queued'
        using errcode = '23514';
    end if;

    if v_new_terminal and new.finished_at is null then
      new.finished_at := statement_timestamp();
    end if;
  end if;

  new.updated_at := statement_timestamp();
  return new;
end;
$$;

create trigger runs_20_enforce_lifecycle
before update or delete on public.runs
for each row execute function private.enforce_run_lifecycle();

create or replace function private.prevent_evidence_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mutable_columns text[];
begin
  if tg_op = 'DELETE' then
    raise exception '% records cannot be deleted', tg_table_name
      using errcode = '55000';
  end if;

  if tg_table_name in ('artifacts', 'metric_observations') then
    v_mutable_columns := array['archived_at', 'tombstoned_at'];
  else
    v_mutable_columns := array['archived_at'];
  end if;

  if (to_jsonb(new) - v_mutable_columns)
    is distinct from
    (to_jsonb(old) - v_mutable_columns)
  then
    raise exception '% records are append-only', tg_table_name
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger metric_observations_10_append_only
before update or delete on public.metric_observations
for each row execute function private.prevent_evidence_mutation();

create trigger code_references_10_append_only
before update or delete on public.code_references
for each row execute function private.prevent_evidence_mutation();

create trigger data_references_10_append_only
before update or delete on public.data_references
for each row execute function private.prevent_evidence_mutation();

create trigger artifacts_10_append_only
before update or delete on public.artifacts
for each row execute function private.prevent_evidence_mutation();

create or replace function private.enforce_api_token_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'API tokens are revoked, not deleted'
      using errcode = '55000';
  end if;

  if new.id is distinct from old.id
    or new.workspace_id is distinct from old.workspace_id
    or new.user_id is distinct from old.user_id
    or new.token_hash is distinct from old.token_hash
    or new.created_at is distinct from old.created_at
  then
    raise exception 'API token identity and hash are immutable'
      using errcode = '55000';
  end if;

  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'API token revocation is irreversible'
      using errcode = '55000';
  end if;

  new.updated_at := statement_timestamp();
  return new;
end;
$$;

create trigger api_tokens_10_enforce_lifecycle
before update or delete on public.api_tokens
for each row execute function private.enforce_api_token_lifecycle();

create or replace function private.prevent_audit_event_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'audit events are append-only'
    using errcode = '55000';
end;
$$;

create trigger audit_events_10_append_only
before update or delete on public.audit_events
for each row execute function private.prevent_audit_event_mutation();

create trigger workspaces_90_touch_updated_at
before update on public.workspaces
for each row execute function private.touch_updated_at();

create trigger spaces_90_touch_updated_at
before update on public.spaces
for each row execute function private.touch_updated_at();

create trigger metric_definitions_90_touch_updated_at
before update on public.metric_definitions
for each row execute function private.touch_updated_at();
