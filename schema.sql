-- Smart Lawn Watering Assistant — Supabase schema
-- Run this whole file once in the Supabase SQL Editor (Project > SQL Editor > New query).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- water_logs: every rain observation you log manually and every irrigation
-- session you run. (Live rain/forecast data comes from Open-Meteo at read
-- time — this table is for logged/manual entries and historical overrides.)
-- ---------------------------------------------------------------------------
create table if not exists water_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  type text not null check (type in ('rain', 'irrigation')),
  amount_inches float not null check (amount_inches >= 0),
  notes text
);

alter table water_logs enable row level security;

create policy "anon can read water_logs"
  on water_logs for select
  using (true);

create policy "anon can insert water_logs"
  on water_logs for insert
  with check (true);

create policy "anon can update water_logs"
  on water_logs for update
  using (true)
  with check (true);

create policy "anon can delete water_logs"
  on water_logs for delete
  using (true);

-- ---------------------------------------------------------------------------
-- lawn_settings: single-row configuration shared by the frontend and the
-- scheduled Edge Function, so both compute the exact same phase/status.
-- ---------------------------------------------------------------------------
create table if not exists lawn_settings (
  id int primary key default 1 check (id = 1), -- enforced single row
  seed_date date not null,
  grass_type text not null default 'kentucky_bluegrass'
    check (grass_type in ('kentucky_bluegrass', 'cool_season_other', 'warm_season', 'custom')),
  phase1_end_day int not null default 21,   -- Germination -> Root Development cutoff
  phase2_end_day int not null default 42,   -- Root Development -> Establishment cutoff
  weekly_target_inches float not null default 1.25, -- Establishment-phase weekly cumulative target
  root_dev_weekly_inches float not null default 1.0, -- Phase 2 weekly target
  germination_sessions_per_day int not null default 3, -- Phase 1 watering frequency
  establishment_interval_days float not null default 3.5, -- Phase 3 (and Phase 2 taper target) watering interval
  latitude float,
  longitude float,
  alert_email text,
  updated_at timestamptz not null default now()
);

alter table lawn_settings enable row level security;

create policy "anon can read lawn_settings"
  on lawn_settings for select
  using (true);

create policy "anon can upsert lawn_settings"
  on lawn_settings for insert
  with check (true);

create policy "anon can update lawn_settings"
  on lawn_settings for update
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- alert_history: one row per email the Edge Function actually sends, so it
-- can avoid re-sending the same "still skip" / "still water" alert on every
-- cron run.
-- ---------------------------------------------------------------------------
create table if not exists alert_history (
  id uuid primary key default gen_random_uuid(),
  sent_at timestamptz not null default now(),
  phase text not null,
  status_key text not null,   -- machine-readable status (e.g. 'water_now', 'skip_rain', 'skip_saturated')
  status_text text not null   -- human-readable message that was emailed
);

alter table alert_history enable row level security;

create policy "anon can read alert_history"
  on alert_history for select
  using (true);

create policy "service role can insert alert_history"
  on alert_history for insert
  with check (true);

-- ---------------------------------------------------------------------------
-- NOTE ON SECURITY: these policies allow anyone holding the anon public key
-- to read/write this data. That's an acceptable tradeoff for a private,
-- single-user tool where the anon key isn't shared publicly. If you ever
-- expose this app's URL/key beyond yourself, switch to Supabase Auth and
-- scope these policies to auth.uid().
-- ---------------------------------------------------------------------------
