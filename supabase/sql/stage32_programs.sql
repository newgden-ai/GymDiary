-- =========================================================
-- Этап 32: свои программы (сплиты). Тренер собирает программу и назначает подопечному
-- (например, 3 дня: 2 тренировки низа тела + 1 верха), расставляя порядок тренировок и приоритетные группы мышц.
-- Пользователь может собрать программу и для себя. Повторный запуск безопасен.
-- =========================================================
create table if not exists programs (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references profiles(id) on delete cascade,
  trainee_id uuid references profiles(id) on delete cascade,   -- null — программа для себя
  title      text not null check (length(title) between 1 and 80),
  days       jsonb not null default '[]'::jsonb,               -- [{id,title,focus:[...],ex:[[название, подходы, 'повторы'],…]}]
  focus      jsonb not null default '[]'::jsonb,               -- приоритетные группы мышц
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table programs enable row level security;

-- подопечный: связь тренер → ученик принята
create or replace function is_my_trainee(p_trainee uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from trainer_links where trainer_id = auth.uid() and trainee_id = p_trainee and status = 'accepted');
$$;
grant execute on function is_my_trainee(uuid) to authenticated;

drop policy if exists programs_select on programs;
drop policy if exists programs_insert on programs;
drop policy if exists programs_update on programs;
drop policy if exists programs_delete on programs;
create policy programs_select on programs for select using (owner_id = auth.uid() or trainee_id = auth.uid() or is_admin());
create policy programs_insert on programs for insert with check (owner_id = auth.uid() and (trainee_id is null or trainee_id = auth.uid() or is_my_trainee(trainee_id)));
create policy programs_update on programs for update using (owner_id = auth.uid()) with check (owner_id = auth.uid() and (trainee_id is null or trainee_id = auth.uid() or is_my_trainee(trainee_id)));
create policy programs_delete on programs for delete using (owner_id = auth.uid());
grant select, insert, update, delete on table programs to authenticated;
