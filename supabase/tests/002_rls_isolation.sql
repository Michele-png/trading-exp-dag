begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(19);

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at
)
values
  (
    '11000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'rls-user-one@example.test',
    '',
    now(),
    now(),
    now()
  ),
  (
    '11000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'rls-user-two@example.test',
    '',
    now(),
    now(),
    now()
  );

insert into public.workspaces (id, kind, name, slug, created_by)
values
  (
    '21000000-0000-0000-0000-000000000001',
    'team',
    'RLS workspace one',
    'rls-workspace-one',
    '11000000-0000-0000-0000-000000000001'
  ),
  (
    '21000000-0000-0000-0000-000000000002',
    'team',
    'RLS workspace two',
    'rls-workspace-two',
    '11000000-0000-0000-0000-000000000002'
  );

insert into public.spaces (id, workspace_id, name, slug, created_by)
values
  (
    '31000000-0000-0000-0000-000000000001',
    '21000000-0000-0000-0000-000000000001',
    'RLS space one',
    'rls-space-one',
    '11000000-0000-0000-0000-000000000001'
  ),
  (
    '31000000-0000-0000-0000-000000000002',
    '21000000-0000-0000-0000-000000000002',
    'RLS space two',
    'rls-space-two',
    '11000000-0000-0000-0000-000000000002'
  );

insert into public.nodes (id, space_id, kind, created_by)
values
  (
    '41000000-0000-0000-0000-000000000001',
    '31000000-0000-0000-0000-000000000001',
    'experiment',
    '11000000-0000-0000-0000-000000000001'
  ),
  (
    '41000000-0000-0000-0000-000000000002',
    '31000000-0000-0000-0000-000000000002',
    'experiment',
    '11000000-0000-0000-0000-000000000002'
  );

insert into public.node_revisions (
  id,
  space_id,
  node_id,
  title,
  hypothesis,
  method,
  created_by
)
values
  (
    '51000000-0000-0000-0000-000000000001',
    '31000000-0000-0000-0000-000000000001',
    '41000000-0000-0000-0000-000000000001',
    'RLS experiment one',
    'Only workspace one should see this',
    'RLS method one',
    '11000000-0000-0000-0000-000000000001'
  ),
  (
    '51000000-0000-0000-0000-000000000002',
    '31000000-0000-0000-0000-000000000002',
    '41000000-0000-0000-0000-000000000002',
    'RLS experiment two',
    'Only workspace two should see this',
    'RLS method two',
    '11000000-0000-0000-0000-000000000002'
  );

insert into public.artifacts (
  id,
  space_id,
  node_revision_id,
  name,
  checksum,
  storage_path,
  owner_user_id,
  created_by
)
values
  (
    '71000000-0000-0000-0000-000000000001',
    '31000000-0000-0000-0000-000000000001',
    '51000000-0000-0000-0000-000000000001',
    'Owned evidence one',
    'evidence-checksum-one',
    '31000000-0000-0000-0000-000000000001/71000000-0000-0000-0000-000000000001/evidence.txt',
    '11000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000001'
  ),
  (
    '71000000-0000-0000-0000-000000000002',
    '31000000-0000-0000-0000-000000000001',
    '51000000-0000-0000-0000-000000000001',
    'Owned evidence two',
    'evidence-checksum-two',
    '31000000-0000-0000-0000-000000000001/71000000-0000-0000-0000-000000000002/evidence.txt',
    '11000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000001'
  );

insert into public.api_tokens (
  id,
  workspace_id,
  user_id,
  name,
  token_hash,
  scopes
)
values
  (
    '81000000-0000-0000-0000-000000000001',
    '21000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000001',
    'User one token',
    decode(repeat('11', 32), 'hex'),
    array['experiments:read']
  ),
  (
    '81000000-0000-0000-0000-000000000002',
    '21000000-0000-0000-0000-000000000002',
    '11000000-0000-0000-0000-000000000002',
    'User two token',
    decode(repeat('22', 32), 'hex'),
    array['experiments:read']
  );

insert into public.audit_events (
  workspace_id,
  actor_user_id,
  action,
  resource_type,
  resource_id
)
values (
  '21000000-0000-0000-0000-000000000001',
  '11000000-0000-0000-0000-000000000001',
  'experiment.created',
  'node',
  '41000000-0000-0000-0000-000000000001'
);

select is(
  (
    select count(*)
    from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
    where pg_namespace.nspname = 'public'
      and pg_class.relname = any (
        array[
          'workspaces',
          'workspace_members',
          'spaces',
          'nodes',
          'node_revisions',
          'node_lineage',
          'semantic_links',
          'runs',
          'metric_definitions',
          'metric_observations',
          'code_references',
          'data_references',
          'artifacts',
          'api_tokens',
          'idempotency_keys',
          'audit_events'
        ]
      )
      and not pg_class.relrowsecurity
  ),
  0::bigint,
  'RLS is enabled on every exposed application table'
);

select is(
  (select public from storage.buckets where id = 'evidence'),
  false,
  'the evidence Storage bucket is private'
);

select set_config(
  'request.jwt.claim.sub',
  '11000000-0000-0000-0000-000000000001',
  true
);
set local role authenticated;

select is(
  (
    select count(*)
    from public.workspaces
    where id = '21000000-0000-0000-0000-000000000001'
  ),
  1::bigint,
  'user one can read their team workspace'
);

select is(
  (
    select count(*)
    from public.workspaces
    where id = '21000000-0000-0000-0000-000000000002'
  ),
  0::bigint,
  'user one cannot read another team workspace'
);

select is(
  (
    select count(*)
    from public.workspaces
    where kind = 'personal'
      and personal_owner_user_id = '11000000-0000-0000-0000-000000000001'
  ),
  1::bigint,
  'an auth user receives one personal workspace'
);

select is(
  (
    select count(*)
    from public.spaces
    where id = '31000000-0000-0000-0000-000000000001'
  ),
  1::bigint,
  'user one can read their space'
);

select is(
  (
    select count(*)
    from public.spaces
    where id = '31000000-0000-0000-0000-000000000002'
  ),
  0::bigint,
  'user one cannot read another workspace space'
);

select is(
  (
    select count(*)
    from public.nodes
    where space_id = '31000000-0000-0000-0000-000000000001'
  ),
  2::bigint,
  'user one can read objective and experiment nodes in their space'
);

select is(
  (
    select count(*)
    from public.nodes
    where space_id = '31000000-0000-0000-0000-000000000002'
  ),
  0::bigint,
  'user one cannot read nodes in another workspace'
);

select throws_ok(
  $$
    insert into public.nodes (space_id, kind, created_by)
    values (
      '31000000-0000-0000-0000-000000000002',
      'experiment',
      '11000000-0000-0000-0000-000000000001'
    )
  $$,
  42501,
  null,
  'user one cannot create a node in another workspace'
);

select is(
  (
    select count(*)
    from public.api_tokens
    where id = '81000000-0000-0000-0000-000000000001'
  ),
  1::bigint,
  'user one can read their own token metadata'
);

select is(
  (
    select count(*)
    from public.api_tokens
    where id = '81000000-0000-0000-0000-000000000002'
  ),
  0::bigint,
  'user one cannot read another workspace token hash'
);

select lives_ok(
  $$
    insert into storage.objects (bucket_id, name, owner_id)
    values (
      'evidence',
      '31000000-0000-0000-0000-000000000001/71000000-0000-0000-0000-000000000001/evidence.txt',
      '11000000-0000-0000-0000-000000000001'
    )
  $$,
  'an artifact owner can upload its registered Storage object'
);

select is(
  (
    select count(*)
    from storage.objects
    where bucket_id = 'evidence'
      and name = '31000000-0000-0000-0000-000000000001/71000000-0000-0000-0000-000000000001/evidence.txt'
  ),
  1::bigint,
  'the artifact owner can read the private object'
);

select is(
  (select count(*) from public.audit_events),
  1::bigint,
  'workspace audit events are visible to their members'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  '11000000-0000-0000-0000-000000000002',
  true
);
set local role authenticated;

select is(
  (
    select count(*)
    from storage.objects
    where bucket_id = 'evidence'
      and name = '31000000-0000-0000-0000-000000000001/71000000-0000-0000-0000-000000000001/evidence.txt'
  ),
  0::bigint,
  'another workspace member cannot read the private object'
);

select throws_ok(
  $$
    insert into storage.objects (bucket_id, name, owner_id)
    values (
      'evidence',
      '31000000-0000-0000-0000-000000000001/71000000-0000-0000-0000-000000000002/evidence.txt',
      '11000000-0000-0000-0000-000000000002'
    )
  $$,
  42501,
  null,
  'another workspace member cannot upload against someone else''s artifact'
);

select is(
  (select count(*) from public.audit_events),
  0::bigint,
  'another workspace cannot read private audit events'
);

select is(
  (
    select count(*)
    from public.workspaces
    where id = '21000000-0000-0000-0000-000000000002'
  ),
  1::bigint,
  'user two can still read their own workspace'
);

select * from finish();
rollback;
