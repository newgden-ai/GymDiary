-- =========================================================
-- Этап 4: бот (анкета, итоги тренировок, утро/вечер/мотивация), личные данные, вес, активность
-- Supabase → SQL Editor → вставить целиком → Run. Повторный запуск безопасен.
-- =========================================================

-- ---- служебные поля бота в профиле ----
alter table profiles add column if not exists bot_state jsonb not null default '{}';
alter table profiles add column if not exists onboarded boolean not null default false;
alter table profiles add column if not exists reminders boolean not null default true;
alter table profiles add column if not exists last_evening_date date;
alter table profiles add column if not exists last_motivation_date date;

-- ---- личные данные: отдельная таблица, чтобы друзья не видели их через profiles ----
create table if not exists profile_details (
  user_id uuid primary key references profiles(id) on delete cascade,
  birth_date date,                 -- из возраста в анкете (приблизительно)
  gender text check (gender in ('male','female')),
  weight_kg numeric,
  height_cm numeric,
  goal text,
  show_public boolean not null default false,   -- «показывать» всем участникам
  show_trainer boolean not null default false,  -- «показывать тренеру»
  updated_at timestamptz not null default now()
);
alter table profile_details enable row level security;

create or replace function can_see_details(owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select owner = auth.uid() or is_admin() or exists(
    select 1 from profile_details d where d.user_id = owner and (
      (d.show_public and are_friends(owner, auth.uid())) or
      (d.show_trainer and exists(select 1 from trainer_links tl where tl.trainee_id = owner and tl.trainer_id = auth.uid() and tl.active))
    ));
$$;

drop policy if exists profile_details_select on profile_details;
create policy profile_details_select on profile_details for select using (can_see_details(user_id));
drop policy if exists profile_details_write on profile_details;
create policy profile_details_write on profile_details for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- вес по дням ----
create table if not exists body_weights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  date date not null,
  weight_kg numeric not null,
  unique (user_id, date)
);
alter table body_weights enable row level security;
drop policy if exists body_weights_select on body_weights;
create policy body_weights_select on body_weights for select using (can_see_details(user_id));
drop policy if exists body_weights_write on body_weights;
create policy body_weights_write on body_weights for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- активность в дни без тренировок (ответы боту) ----
create table if not exists daily_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  date date not null,
  kind text not null,          -- work, steps, moving, house, outdoor, sport, kids, sick, other, none
  steps int,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);
alter table daily_activity enable row level security;
drop policy if exists daily_activity_select on daily_activity;
create policy daily_activity_select on daily_activity for select using (can_see_details(user_id));
drop policy if exists daily_activity_write on daily_activity;
create policy daily_activity_write on daily_activity for all using (user_id = auth.uid()) with check (user_id = auth.uid());
