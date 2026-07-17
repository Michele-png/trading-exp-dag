begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(49);

select enum_has_labels(
  'public',
  'experiment_conclusion_state',
  array['pending', 'supported', 'refuted', 'mixed', 'inconclusive'],
  'scientific conclusion states match the public result contract'
);

select enum_has_labels(
  'public',
  'lineage_link_kind',
  array['derived_from', 'synthesizes'],
  'lineage links preserve ancestry intent'
);

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
    '10000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'schema-owner@example.test',
    '',
    now(),
    now(),
    now()
  ),
  (
    '10000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'other-owner@example.test',
    '',
    now(),
    now(),
    now()
  );

insert into public.workspaces (id, kind, name, slug, created_by)
values
  (
    '20000000-0000-0000-0000-000000000001',
    'team',
    'Schema workspace one',
    'schema-workspace-one',
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    'team',
    'Schema workspace two',
    'schema-workspace-two',
    '10000000-0000-0000-0000-000000000002'
  );

insert into public.spaces (id, workspace_id, name, slug, created_by)
values
  (
    '30000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'Space one',
    'space-one',
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '30000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000002',
    'Space two',
    'space-two',
    '10000000-0000-0000-0000-000000000002'
  );

insert into public.nodes (id, space_id, kind, created_by)
values
  (
    '40000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    'experiment',
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '40000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000001',
    'experiment',
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '40000000-0000-0000-0000-000000000003',
    '30000000-0000-0000-0000-000000000001',
    'experiment',
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '40000000-0000-0000-0000-000000000004',
    '30000000-0000-0000-0000-000000000001',
    'experiment',
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '40000000-0000-0000-0000-000000000005',
    '30000000-0000-0000-0000-000000000001',
    'experiment',
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '40000000-0000-0000-0000-000000000006',
    '30000000-0000-0000-0000-000000000002',
    'experiment',
    '10000000-0000-0000-0000-000000000002'
  );

insert into public.node_revisions (
  id,
  space_id,
  node_id,
  title,
  hypothesis,
  method,
  preregistered_at,
  retrospective,
  created_by
)
values
  (
    '50000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    'Experiment A',
    'A should improve the metric',
    'Method A',
    now() - interval '1 day',
    false,
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '50000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    'Experiment B',
    'B should improve the metric',
    'Method B',
    now() - interval '1 day',
    false,
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '50000000-0000-0000-0000-000000000003',
    '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000003',
    'Experiment C',
    'C should improve the metric',
    'Method C',
    now() - interval '1 day',
    false,
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '50000000-0000-0000-0000-000000000004',
    '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000004',
    'Initially orphaned experiment',
    'The orphan should become reachable',
    'Orphan method',
    now() - interval '1 day',
    false,
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '50000000-0000-0000-0000-000000000005',
    '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000005',
    'Editable draft',
    'Drafts can change',
    'Draft method',
    null,
    true,
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '50000000-0000-0000-0000-000000000006',
    '30000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000006',
    'Other-space experiment',
    'Other-space hypothesis',
    'Other-space method',
    now() - interval '1 day',
    false,
    '10000000-0000-0000-0000-000000000002'
  );

select is(
  (
    select count(*)
    from public.nodes
    where space_id = '30000000-0000-0000-0000-000000000001'
      and kind = 'objective'
  ),
  1::bigint,
  'space one has exactly one automatically provisioned objective'
);

select is(
  (
    select count(*)
    from public.nodes
    where space_id = '30000000-0000-0000-0000-000000000002'
      and kind = 'objective'
  ),
  1::bigint,
  'space two has exactly one automatically provisioned objective'
);

select throws_ok(
  $$
    insert into public.nodes (space_id, kind, created_by)
    values (
      '30000000-0000-0000-0000-000000000001',
      'objective',
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  23505,
  null,
  'a second objective root is rejected'
);

select throws_ok(
  $$
    delete from public.nodes
    where space_id = '30000000-0000-0000-0000-000000000001'
      and kind = 'objective'
  $$,
  23514,
  null,
  'an objective root cannot be deleted'
);

select throws_ok(
  $$
    insert into public.node_lineage (
      space_id,
      parent_node_id,
      child_node_id,
      created_by
    )
    values (
      '30000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000006',
      '40000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  23503,
  null,
  'cross-space lineage is rejected'
);

select lives_ok(
  $$
    insert into public.node_lineage (
      space_id,
      parent_node_id,
      child_node_id,
      created_by
    )
    select
      '30000000-0000-0000-0000-000000000001',
      id,
      '40000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001'
    from public.nodes
    where space_id = '30000000-0000-0000-0000-000000000001'
      and kind = 'objective'
  $$,
  'objective to experiment A lineage is valid'
);

select lives_ok(
  $$
    insert into public.node_lineage (
      space_id,
      parent_node_id,
      child_node_id,
      created_by
    )
    values (
      '30000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  'experiment A to experiment B lineage is valid'
);

select lives_ok(
  $$
    insert into public.node_lineage (
      space_id,
      parent_node_id,
      child_node_id,
      created_by
    )
    select
      '30000000-0000-0000-0000-000000000001',
      id,
      '40000000-0000-0000-0000-000000000003',
      '10000000-0000-0000-0000-000000000001'
    from public.nodes
    where space_id = '30000000-0000-0000-0000-000000000001'
      and kind = 'objective'
  $$,
  'objective to experiment C lineage is valid'
);

select lives_ok(
  $$
    insert into public.node_lineage (
      space_id,
      parent_node_id,
      child_node_id,
      created_by
    )
    values (
      '30000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000002',
      '40000000-0000-0000-0000-000000000003',
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  'experiment C accepts a second lineage parent'
);

select is(
  (
    select count(*)
    from public.node_lineage
    where child_node_id = '40000000-0000-0000-0000-000000000003'
  ),
  2::bigint,
  'an experiment can retain multiple lineage parents'
);

select throws_ok(
  $$
    insert into public.node_lineage (
      space_id,
      parent_node_id,
      child_node_id,
      created_by
    )
    values (
      '30000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000003',
      '40000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  23514,
  null,
  'a recursive lineage cycle is rejected'
);

select throws_ok(
  $$
    update public.node_revisions
    set state = 'finalized'
    where id = '50000000-0000-0000-0000-000000000004'
  $$,
  23514,
  null,
  'an unreachable experiment cannot be finalized'
);

select lives_ok(
  $$
    insert into public.node_lineage (
      space_id,
      parent_node_id,
      child_node_id,
      created_by
    )
    select
      '30000000-0000-0000-0000-000000000001',
      id,
      '40000000-0000-0000-0000-000000000004',
      '10000000-0000-0000-0000-000000000001'
    from public.nodes
    where space_id = '30000000-0000-0000-0000-000000000001'
      and kind = 'objective'
  $$,
  'the orphan can be attached to the objective'
);

select lives_ok(
  $$
    update public.node_revisions
    set state = 'finalized', conclusion = 'Reachability established'
    where id = '50000000-0000-0000-0000-000000000004'
  $$,
  'a root-reachable experiment can be finalized'
);

select lives_ok(
  $$
    update public.node_revisions
    set state = 'finalized', conclusion = 'A conclusion'
    where id = '50000000-0000-0000-0000-000000000001'
  $$,
  'experiment A finalizes when root-reachable'
);

select lives_ok(
  $$
    insert into public.node_revisions (
      id,
      space_id,
      node_id,
      title,
      hypothesis,
      method,
      conclusion,
      created_by
    )
    values (
      '50000000-0000-0000-0000-000000000007',
      '30000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      'Experiment A editorial draft',
      'A should improve the metric',
      'Method A, clarified',
      'A conclusion, clarified',
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  'an editorial draft appends after a finalized revision'
);

select is(
  (
    select revision_number
    from public.node_revisions
    where id = '50000000-0000-0000-0000-000000000007'
  ),
  2::bigint,
  'editorial revision numbers are monotonic'
);

select is(
  (
    select current_revision_id
    from public.nodes
    where id = '40000000-0000-0000-0000-000000000001'
  ),
  '50000000-0000-0000-0000-000000000007'::uuid,
  'the newest editorial draft becomes current'
);

select throws_ok(
  $$
    update public.nodes
    set current_revision_id = '50000000-0000-0000-0000-000000000001'
    where id = '40000000-0000-0000-0000-000000000001'
  $$,
  23514,
  null,
  'current revision pointers cannot be moved to older revisions'
);

select lives_ok(
  $$
    delete from public.node_revisions
    where id = '50000000-0000-0000-0000-000000000007'
  $$,
  'an editorial draft remains deletable'
);

select is(
  (
    select current_revision_id
    from public.nodes
    where id = '40000000-0000-0000-0000-000000000001'
  ),
  '50000000-0000-0000-0000-000000000001'::uuid,
  'deleting an editorial draft restores the latest finalized revision'
);

select throws_ok(
  $$
    delete from public.node_lineage
    where child_node_id = '40000000-0000-0000-0000-000000000001'
      and parent_node_id = (
        select id
        from public.nodes
        where space_id = '30000000-0000-0000-0000-000000000001'
          and kind = 'objective'
      )
  $$,
  23514,
  null,
  'lineage cannot be removed if it disconnects a finalized experiment'
);

select throws_ok(
  $$
    update public.node_revisions
    set title = 'Mutated final title'
    where id = '50000000-0000-0000-0000-000000000001'
  $$,
  55000,
  null,
  'finalized revision content is immutable'
);

select throws_ok(
  $$
    delete from public.node_revisions
    where id = '50000000-0000-0000-0000-000000000001'
  $$,
  55000,
  null,
  'a finalized revision cannot be deleted'
);

select lives_ok(
  $$
    update public.node_revisions
    set state = 'finalized', conclusion = 'B conclusion'
    where id = '50000000-0000-0000-0000-000000000002'
  $$,
  'experiment B can be finalized through experiment A'
);

select lives_ok(
  $$
    insert into public.semantic_links (
      space_id,
      source_node_id,
      target_node_id,
      target_revision_id,
      kind,
      created_by
    )
    values (
      '30000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000002',
      '40000000-0000-0000-0000-000000000001',
      '50000000-0000-0000-0000-000000000001',
      'supports',
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  'a semantic link can point from B to A'
);

select lives_ok(
  $$
    insert into public.semantic_links (
      space_id,
      source_node_id,
      target_node_id,
      target_revision_id,
      kind,
      created_by
    )
    values (
      '30000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000002',
      '50000000-0000-0000-0000-000000000002',
      'contradicts',
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  'reverse semantic links are excluded from DAG cycle checks'
);

select throws_ok(
  $$
    insert into public.semantic_links (
      space_id,
      source_node_id,
      target_node_id,
      target_revision_id,
      kind,
      created_by
    )
    values (
      '30000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000006',
      '40000000-0000-0000-0000-000000000001',
      '50000000-0000-0000-0000-000000000001',
      'replicates',
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  23514,
  null,
  'cross-space semantic links are rejected'
);

select is(
  (select count(*) from public.semantic_links),
  2::bigint,
  'both directions of semantic evidence are retained'
);

select lives_ok(
  $$
    update public.node_revisions
    set title = 'Edited draft title'
    where id = '50000000-0000-0000-0000-000000000005'
  $$,
  'draft revisions remain mutable'
);

select lives_ok(
  $$
    delete from public.node_revisions
    where id = '50000000-0000-0000-0000-000000000005'
  $$,
  'draft revisions remain deletable'
);

select is(
  (
    select current_revision_id
    from public.nodes
    where id = '40000000-0000-0000-0000-000000000005'
  ),
  null::uuid,
  'deleting the only draft clears its current-revision pointer'
);

select throws_ok(
  $$
    delete from public.nodes
    where id = '40000000-0000-0000-0000-000000000001'
  $$,
  55000,
  null,
  'a finalized node cannot be physically deleted'
);

insert into public.nodes (id, space_id, kind, created_by)
values (
  '40000000-0000-0000-0000-000000000007',
  '30000000-0000-0000-0000-000000000001',
  'experiment',
  '10000000-0000-0000-0000-000000000001'
);

insert into public.node_revisions (
  id,
  space_id,
  node_id,
  title,
  hypothesis,
  method,
  preregistered_at,
  created_by
)
values (
  '50000000-0000-0000-0000-000000000007',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000007',
  'Run capture draft',
  'A local run can test a draft hypothesis',
  'Execute the registered command',
  now(),
  '10000000-0000-0000-0000-000000000001'
);

insert into public.node_lineage (
  space_id,
  parent_node_id,
  child_node_id,
  created_by
)
select
  '30000000-0000-0000-0000-000000000001',
  nodes.id,
  '40000000-0000-0000-0000-000000000007',
  '10000000-0000-0000-0000-000000000001'
from public.nodes
where nodes.space_id = '30000000-0000-0000-0000-000000000001'
  and nodes.kind = 'objective';

select throws_ok(
  $$
    insert into public.runs (
      space_id,
      experiment_node_id,
      revision_id,
      status,
      created_by
    )
    values (
      '30000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      '50000000-0000-0000-0000-000000000001',
      'queued',
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  23514,
  null,
  'new runs cannot target an already-finalized revision'
);

select lives_ok(
  $$
    insert into public.runs (
      id,
      space_id,
      experiment_node_id,
      revision_id,
      status,
      command,
      started_at,
      created_by
    )
    values (
      '60000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000007',
      '50000000-0000-0000-0000-000000000007',
      'running',
      'python experiment_a.py',
      now(),
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  'runs can target the current draft experiment revision'
);

select throws_ok(
  $$
    update public.node_revisions
    set state = 'finalized', conclusion = 'Premature conclusion'
    where id = '50000000-0000-0000-0000-000000000007'
  $$,
  23514,
  null,
  'an experiment cannot finalize while a run is active'
);

select lives_ok(
  $$
    update public.runs
    set status = 'succeeded', exit_code = 0
    where id = '60000000-0000-0000-0000-000000000001'
  $$,
  'a running run can enter a terminal state'
);

select lives_ok(
  $$
    update public.node_revisions
    set
      state = 'finalized',
      operational_state = 'completed',
      conclusion_state = 'supported',
      conclusion = 'The completed run supports the hypothesis'
    where id = '50000000-0000-0000-0000-000000000007'
  $$,
  'an experiment can finalize after all runs are terminal'
);

select throws_ok(
  $$
    update public.runs
    set command = 'mutated command'
    where id = '60000000-0000-0000-0000-000000000001'
  $$,
  55000,
  null,
  'terminal run content is immutable'
);

select throws_ok(
  $$
    delete from public.runs
    where id = '60000000-0000-0000-0000-000000000001'
  $$,
  55000,
  null,
  'terminal runs cannot be physically deleted'
);

select lives_ok(
  $$
    update public.runs
    set archived_at = now(), tombstoned_at = now()
    where id = '60000000-0000-0000-0000-000000000001'
  $$,
  'terminal runs can be archived and tombstoned'
);

select lives_ok(
  $$
    update public.node_revisions
    set archived_at = now(), tombstoned_at = now()
    where id = '50000000-0000-0000-0000-000000000001'
  $$,
  'finalized revisions can be archived and tombstoned'
);

select lives_ok(
  $$
    update public.nodes
    set archived_at = now(), tombstoned_at = now()
    where id = '40000000-0000-0000-0000-000000000001'
  $$,
  'finalized nodes can be archived and tombstoned'
);

select is(
  (
    select operational_state::text
    from public.node_revisions
    where id = '50000000-0000-0000-0000-000000000001'
  ),
  'planned',
  'operational state is stored independently'
);

select is(
  (
    select conclusion_state::text
    from public.node_revisions
    where id = '50000000-0000-0000-0000-000000000001'
  ),
  'pending',
  'conclusion state is stored independently'
);

select ok(
  (
    select preregistered_at is not null and not retrospective
    from public.node_revisions
    where id = '50000000-0000-0000-0000-000000000001'
  ),
  'preregistration timestamp and retrospective flag are retained'
);

select has_index(
  'public',
  'node_revisions',
  'node_revisions_search_document_idx',
  'experiment revision full-text search is indexed'
);

select * from finish();
rollback;
