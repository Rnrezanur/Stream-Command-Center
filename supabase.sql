create table if not exists public.platform_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_json text not null,
  updated_at timestamptz not null default now()
);

alter table public.platform_settings enable row level security;

-- The application accesses this table only through its server-side Supabase
-- secret/service-role key. No browser role receives direct table access.

create table if not exists public.obs_agents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  pairing_code_hash text,
  pairing_expires_at timestamptz,
  agent_token_hash text,
  state_json jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.obs_commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_type text not null,
  request_data jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  result_json jsonb,
  error_text text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists obs_commands_user_status_created_idx
  on public.obs_commands (user_id, status, created_at);

alter table public.obs_agents enable row level security;
alter table public.obs_commands enable row level security;

-- These tables are accessed only by the server-side Supabase secret key.

-- Atomically reserve pending commands for an agent. This prevents duplicate
-- execution and removes the separate select/update round trip from polling.
create or replace function public.claim_obs_commands(p_user_id uuid)
returns setof public.obs_commands
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select id
    from public.obs_commands
    where user_id = p_user_id
      and status = 'pending'
      and created_at >= now() - interval '15 seconds'
    order by created_at
    for update skip locked
    limit 20
  )
  update public.obs_commands as command
  set status = 'processing'
  from claimed
  where command.id = claimed.id
  returning command.*;
end;
$$;

revoke all on function public.claim_obs_commands(uuid) from public, anon, authenticated;
grant execute on function public.claim_obs_commands(uuid) to service_role;
