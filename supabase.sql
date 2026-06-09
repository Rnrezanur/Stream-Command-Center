create table if not exists public.platform_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_json text not null,
  updated_at timestamptz not null default now()
);

alter table public.platform_settings enable row level security;

-- The application accesses this table only through its server-side Supabase
-- secret/service-role key. No browser role receives direct table access.
