-- Tenant isolation, least-privilege grants, and private evidence storage.

create or replace function private.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members
    where workspace_members.workspace_id = p_workspace_id
      and workspace_members.user_id = (select auth.uid())
      and workspace_members.removed_at is null
  );
$$;

create or replace function private.has_workspace_role(
  p_workspace_id uuid,
  p_roles public.workspace_member_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members
    where workspace_members.workspace_id = p_workspace_id
      and workspace_members.user_id = (select auth.uid())
      and workspace_members.removed_at is null
      and workspace_members.role = any (p_roles)
  );
$$;

create or replace function private.is_space_member(p_space_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.spaces
    join public.workspace_members
      on workspace_members.workspace_id = spaces.workspace_id
    where spaces.id = p_space_id
      and workspace_members.user_id = (select auth.uid())
      and workspace_members.removed_at is null
  );
$$;

create or replace function private.can_edit_space(p_space_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.spaces
    join public.workspace_members
      on workspace_members.workspace_id = spaces.workspace_id
    where spaces.id = p_space_id
      and workspace_members.user_id = (select auth.uid())
      and workspace_members.removed_at is null
      and workspace_members.role = any (
        array[
          'owner'::public.workspace_member_role,
          'admin'::public.workspace_member_role,
          'member'::public.workspace_member_role
        ]
      )
  );
$$;

create or replace function private.can_manage_space(p_space_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.spaces
    join public.workspace_members
      on workspace_members.workspace_id = spaces.workspace_id
    where spaces.id = p_space_id
      and workspace_members.user_id = (select auth.uid())
      and workspace_members.removed_at is null
      and workspace_members.role = any (
        array[
          'owner'::public.workspace_member_role,
          'admin'::public.workspace_member_role
        ]
      )
  );
$$;

create or replace function private.can_read_evidence_object(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.artifacts
    join public.spaces
      on spaces.id = artifacts.space_id
    join public.workspace_members
      on workspace_members.workspace_id = spaces.workspace_id
    where artifacts.storage_path = p_object_name
      and artifacts.tombstoned_at is null
      and workspace_members.user_id = (select auth.uid())
      and workspace_members.removed_at is null
  );
$$;

create or replace function private.can_write_evidence_object(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.artifacts
    join public.spaces
      on spaces.id = artifacts.space_id
    join public.workspace_members
      on workspace_members.workspace_id = spaces.workspace_id
    where artifacts.storage_path = p_object_name
      and artifacts.owner_user_id = (select auth.uid())
      and artifacts.archived_at is null
      and artifacts.tombstoned_at is null
      and workspace_members.user_id = (select auth.uid())
      and workspace_members.removed_at is null
      and workspace_members.role <> 'viewer'::public.workspace_member_role
  );
$$;

revoke all on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.is_workspace_member(uuid) to authenticated;
grant execute on function private.has_workspace_role(
  uuid,
  public.workspace_member_role[]
) to authenticated;
grant execute on function private.is_space_member(uuid) to authenticated;
grant execute on function private.can_edit_space(uuid) to authenticated;
grant execute on function private.can_manage_space(uuid) to authenticated;
grant execute on function private.can_read_evidence_object(text) to authenticated;
grant execute on function private.can_write_evidence_object(text) to authenticated;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.spaces enable row level security;
alter table public.nodes enable row level security;
alter table public.node_revisions enable row level security;
alter table public.node_lineage enable row level security;
alter table public.semantic_links enable row level security;
alter table public.runs enable row level security;
alter table public.metric_definitions enable row level security;
alter table public.metric_observations enable row level security;
alter table public.code_references enable row level security;
alter table public.data_references enable row level security;
alter table public.artifacts enable row level security;
alter table public.api_tokens enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.audit_events enable row level security;

create policy workspaces_select_member
on public.workspaces
for select
to authenticated
using ((select private.is_workspace_member(id)));

create policy workspaces_insert_team
on public.workspaces
for insert
to authenticated
with check (
  kind = 'team'::public.workspace_kind
  and personal_owner_user_id is null
  and created_by = (select auth.uid())
);

create policy workspaces_update_manager
on public.workspaces
for update
to authenticated
using (
  (select private.has_workspace_role(
    id,
    array[
      'owner'::public.workspace_member_role,
      'admin'::public.workspace_member_role
    ]
  ))
)
with check (
  (select private.has_workspace_role(
    id,
    array[
      'owner'::public.workspace_member_role,
      'admin'::public.workspace_member_role
    ]
  ))
);

create policy workspaces_delete_team_owner
on public.workspaces
for delete
to authenticated
using (
  kind = 'team'::public.workspace_kind
  and (select private.has_workspace_role(
    id,
    array['owner'::public.workspace_member_role]
  ))
);

create policy workspace_members_select_member
on public.workspace_members
for select
to authenticated
using ((select private.is_workspace_member(workspace_id)));

create policy workspace_members_insert_manager
on public.workspace_members
for insert
to authenticated
with check (
  (select private.has_workspace_role(
    workspace_id,
    array[
      'owner'::public.workspace_member_role,
      'admin'::public.workspace_member_role
    ]
  ))
);

create policy workspace_members_update_manager
on public.workspace_members
for update
to authenticated
using (
  (select private.has_workspace_role(
    workspace_id,
    array[
      'owner'::public.workspace_member_role,
      'admin'::public.workspace_member_role
    ]
  ))
)
with check (
  (select private.has_workspace_role(
    workspace_id,
    array[
      'owner'::public.workspace_member_role,
      'admin'::public.workspace_member_role
    ]
  ))
);

create policy workspace_members_delete_manager
on public.workspace_members
for delete
to authenticated
using (
  (select private.has_workspace_role(
    workspace_id,
    array[
      'owner'::public.workspace_member_role,
      'admin'::public.workspace_member_role
    ]
  ))
);

create policy spaces_select_member
on public.spaces
for select
to authenticated
using ((select private.is_workspace_member(workspace_id)));

create policy spaces_insert_editor
on public.spaces
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.has_workspace_role(
    workspace_id,
    array[
      'owner'::public.workspace_member_role,
      'admin'::public.workspace_member_role,
      'member'::public.workspace_member_role
    ]
  ))
);

create policy spaces_update_editor
on public.spaces
for update
to authenticated
using ((select private.can_edit_space(id)))
with check ((select private.can_edit_space(id)));

create policy spaces_delete_manager
on public.spaces
for delete
to authenticated
using ((select private.can_manage_space(id)));

create policy nodes_select_member
on public.nodes
for select
to authenticated
using ((select private.is_space_member(space_id)));

create policy nodes_insert_experiment_editor
on public.nodes
for insert
to authenticated
with check (
  kind = 'experiment'::public.node_kind
  and created_by = (select auth.uid())
  and (select private.can_edit_space(space_id))
);

create policy nodes_update_editor
on public.nodes
for update
to authenticated
using ((select private.can_edit_space(space_id)))
with check ((select private.can_edit_space(space_id)));

create policy nodes_delete_editor
on public.nodes
for delete
to authenticated
using ((select private.can_edit_space(space_id)));

create policy node_revisions_select_member
on public.node_revisions
for select
to authenticated
using ((select private.is_space_member(space_id)));

create policy node_revisions_insert_editor
on public.node_revisions
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.can_edit_space(space_id))
);

create policy node_revisions_update_editor
on public.node_revisions
for update
to authenticated
using ((select private.can_edit_space(space_id)))
with check ((select private.can_edit_space(space_id)));

create policy node_revisions_delete_editor
on public.node_revisions
for delete
to authenticated
using ((select private.can_edit_space(space_id)));

create policy node_lineage_select_member
on public.node_lineage
for select
to authenticated
using ((select private.is_space_member(space_id)));

create policy node_lineage_insert_editor
on public.node_lineage
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.can_edit_space(space_id))
);

create policy node_lineage_update_editor
on public.node_lineage
for update
to authenticated
using ((select private.can_edit_space(space_id)))
with check ((select private.can_edit_space(space_id)));

create policy node_lineage_delete_editor
on public.node_lineage
for delete
to authenticated
using ((select private.can_edit_space(space_id)));

create policy semantic_links_select_member
on public.semantic_links
for select
to authenticated
using ((select private.is_space_member(space_id)));

create policy semantic_links_insert_editor
on public.semantic_links
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.can_edit_space(space_id))
);

create policy semantic_links_update_editor
on public.semantic_links
for update
to authenticated
using ((select private.can_edit_space(space_id)))
with check ((select private.can_edit_space(space_id)));

create policy semantic_links_delete_editor
on public.semantic_links
for delete
to authenticated
using ((select private.can_edit_space(space_id)));

create policy runs_select_member
on public.runs
for select
to authenticated
using ((select private.is_space_member(space_id)));

create policy runs_insert_editor
on public.runs
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.can_edit_space(space_id))
);

create policy runs_update_editor
on public.runs
for update
to authenticated
using ((select private.can_edit_space(space_id)))
with check ((select private.can_edit_space(space_id)));

create policy runs_delete_editor
on public.runs
for delete
to authenticated
using ((select private.can_edit_space(space_id)));

create policy metric_definitions_select_member
on public.metric_definitions
for select
to authenticated
using ((select private.is_space_member(space_id)));

create policy metric_definitions_insert_editor
on public.metric_definitions
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.can_edit_space(space_id))
);

create policy metric_definitions_update_editor
on public.metric_definitions
for update
to authenticated
using ((select private.can_edit_space(space_id)))
with check ((select private.can_edit_space(space_id)));

create policy metric_definitions_delete_manager
on public.metric_definitions
for delete
to authenticated
using ((select private.can_manage_space(space_id)));

create policy metric_observations_select_member
on public.metric_observations
for select
to authenticated
using ((select private.is_space_member(space_id)));

create policy metric_observations_insert_editor
on public.metric_observations
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.can_edit_space(space_id))
);

create policy metric_observations_update_editor
on public.metric_observations
for update
to authenticated
using ((select private.can_edit_space(space_id)))
with check ((select private.can_edit_space(space_id)));

create policy metric_observations_delete_editor
on public.metric_observations
for delete
to authenticated
using ((select private.can_edit_space(space_id)));

create policy code_references_select_member
on public.code_references
for select
to authenticated
using ((select private.is_space_member(space_id)));

create policy code_references_insert_editor
on public.code_references
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.can_edit_space(space_id))
);

create policy code_references_update_editor
on public.code_references
for update
to authenticated
using ((select private.can_edit_space(space_id)))
with check ((select private.can_edit_space(space_id)));

create policy code_references_delete_editor
on public.code_references
for delete
to authenticated
using ((select private.can_edit_space(space_id)));

create policy data_references_select_member
on public.data_references
for select
to authenticated
using ((select private.is_space_member(space_id)));

create policy data_references_insert_editor
on public.data_references
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.can_edit_space(space_id))
);

create policy data_references_update_editor
on public.data_references
for update
to authenticated
using ((select private.can_edit_space(space_id)))
with check ((select private.can_edit_space(space_id)));

create policy data_references_delete_editor
on public.data_references
for delete
to authenticated
using ((select private.can_edit_space(space_id)));

create policy artifacts_select_member
on public.artifacts
for select
to authenticated
using ((select private.is_space_member(space_id)));

create policy artifacts_insert_editor
on public.artifacts
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and owner_user_id = (select auth.uid())
  and (select private.can_edit_space(space_id))
);

create policy artifacts_update_editor
on public.artifacts
for update
to authenticated
using ((select private.can_edit_space(space_id)))
with check ((select private.can_edit_space(space_id)));

create policy artifacts_delete_editor
on public.artifacts
for delete
to authenticated
using ((select private.can_edit_space(space_id)));

create policy api_tokens_select_owner_or_manager
on public.api_tokens
for select
to authenticated
using (
  (
    user_id = (select auth.uid())
    and (select private.is_workspace_member(workspace_id))
  )
  or (select private.has_workspace_role(
    workspace_id,
    array[
      'owner'::public.workspace_member_role,
      'admin'::public.workspace_member_role
    ]
  ))
);

create policy api_tokens_insert_owner
on public.api_tokens
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and (select private.is_workspace_member(workspace_id))
);

create policy api_tokens_update_owner_or_manager
on public.api_tokens
for update
to authenticated
using (
  (
    user_id = (select auth.uid())
    and (select private.is_workspace_member(workspace_id))
  )
  or (select private.has_workspace_role(
    workspace_id,
    array[
      'owner'::public.workspace_member_role,
      'admin'::public.workspace_member_role
    ]
  ))
)
with check (
  (
    user_id = (select auth.uid())
    and (select private.is_workspace_member(workspace_id))
  )
  or (select private.has_workspace_role(
    workspace_id,
    array[
      'owner'::public.workspace_member_role,
      'admin'::public.workspace_member_role
    ]
  ))
);

create policy idempotency_keys_select_member
on public.idempotency_keys
for select
to authenticated
using ((select private.is_workspace_member(workspace_id)));

create policy idempotency_keys_insert_member
on public.idempotency_keys
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.is_workspace_member(workspace_id))
);

create policy idempotency_keys_update_member
on public.idempotency_keys
for update
to authenticated
using ((select private.is_workspace_member(workspace_id)))
with check ((select private.is_workspace_member(workspace_id)));

create policy idempotency_keys_delete_member
on public.idempotency_keys
for delete
to authenticated
using ((select private.is_workspace_member(workspace_id)));

create policy audit_events_select_member
on public.audit_events
for select
to authenticated
using ((select private.is_workspace_member(workspace_id)));

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select, insert, update, delete
  on public.workspaces,
     public.workspace_members,
     public.spaces,
     public.nodes,
     public.node_revisions,
     public.node_lineage,
     public.semantic_links,
     public.runs,
     public.metric_definitions,
     public.metric_observations,
     public.code_references,
     public.data_references,
     public.artifacts,
     public.api_tokens,
     public.idempotency_keys
  to authenticated;
grant select on public.audit_events to authenticated;
grant usage, select on all sequences in schema public to authenticated;

grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit
)
values (
  'evidence',
  'evidence',
  false,
  52428800
)
on conflict (id)
do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit;

create policy evidence_objects_select_member
on storage.objects
for select
to authenticated
using (
  bucket_id = 'evidence'
  and (select private.can_read_evidence_object(name))
);

create policy evidence_objects_insert_owner
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'evidence'
  and owner_id = ((select auth.uid())::text)
  and (select private.can_write_evidence_object(name))
);

create policy evidence_objects_update_owner
on storage.objects
for update
to authenticated
using (
  bucket_id = 'evidence'
  and owner_id = ((select auth.uid())::text)
  and (select private.can_write_evidence_object(name))
)
with check (
  bucket_id = 'evidence'
  and owner_id = ((select auth.uid())::text)
  and (select private.can_write_evidence_object(name))
);

create policy evidence_objects_delete_owner
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'evidence'
  and owner_id = ((select auth.uid())::text)
  and (select private.can_write_evidence_object(name))
);
