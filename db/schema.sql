-- LIEN storage schema (Supabase / Postgres).
-- Mirrors the Store interface in api/src/storage/types.ts and the API objects in
-- LIEN-docs.md. Apply via the Supabase SQL editor or `psql`.

create table if not exists agents (
  agent_id        text primary key,
  owner           text not null,
  payment_wallet  text,
  name            text,
  image           text,
  first_seen      timestamptz not null default now(),
  -- True for seeded demo agents. Never present these as live metrics.
  synthetic       boolean not null default false
);

create table if not exists scores (
  agent_id        text primary key references agents(agent_id) on delete cascade,
  score           integer not null check (score between 300 and 850),
  band            text not null check (band in ('poor','fair','good','very_good','excellent')),
  status          text not null check (status in ('good_standing','on_watch','defaulted')),
  -- limit is nullable; stored as its components.
  limit_amount    bigint,
  limit_currency  text,
  limit_period    text check (limit_period in ('day','week','month')),
  attested        boolean not null default false,
  factors         jsonb not null default '[]'::jsonb,
  updated_at      timestamptz not null default now()
);

create index if not exists scores_score_idx  on scores (score desc);
create index if not exists scores_status_idx on scores (status);
create index if not exists scores_updated_idx on scores (updated_at desc);

create table if not exists settlements (
  id            text primary key,
  agent_id      text not null references agents(agent_id) on delete cascade,
  tab_id        text,
  counterparty  text,
  amount        bigint not null,           -- minor units (USDC, 6 decimals)
  currency      text not null default 'USDC',
  status        text not null check (status in ('settled','late','defaulted')),
  on_time       boolean not null,
  occurred_at   timestamptz not null default now()
);

create index if not exists settlements_agent_idx on settlements (agent_id, occurred_at desc);

-- Idempotency for POST /settlements (Idempotency-Key header).
create table if not exists idempotency_keys (
  key            text primary key,
  request_hash   text not null,
  settlement_id  text not null references settlements(id) on delete cascade,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- The backend uses the service-role key, which BYPASSES RLS — so enabling RLS
-- here only constrains the public/anon key used by the Lovable frontend.
-- We grant the frontend READ-ONLY access to the public registry data and keep
-- all writes server-side. idempotency_keys stays private (no anon policy).
-- ---------------------------------------------------------------------------

alter table agents             enable row level security;
alter table scores             enable row level security;
alter table settlements        enable row level security;
alter table idempotency_keys   enable row level security;

-- Public read for the registry + profile pages.
drop policy if exists "public read agents" on agents;
create policy "public read agents" on agents
  for select to anon, authenticated using (true);

drop policy if exists "public read scores" on scores;
create policy "public read scores" on scores
  for select to anon, authenticated using (true);

drop policy if exists "public read settlements" on settlements;
create policy "public read settlements" on settlements
  for select to anon, authenticated using (true);

-- No anon policies on idempotency_keys → it is not readable/writable by the
-- frontend. (The service-role backend bypasses RLS regardless.)
