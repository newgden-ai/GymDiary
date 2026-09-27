-- =========================================================
-- Этап 22.
-- 1) Явные правила доступа к тренировкам (ошибка «new row violates row-level security policy for table workouts»):
--    свои тренировки и тренировки подопечных (активная связь с тренером) — читать и менять; админ — всё.
-- 2) Перенос данных на новый аккаунт Telegram: код переноса (сам пользователь) или перенос админом.
-- SQL Editor → Run. Повторный запуск безопасен.
-- =========================================================

-- ---------- 1. тренировки ----------
create or replace function can_edit_workouts(owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select owner = auth.uid() or is_admin()
      or exists(select 1 from trainer_links where trainer_id = auth.uid() and trainee_id = owner and active);
$$;
grant execute on function can_edit_workouts(uuid) to authenticated;

alter table workouts enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'workouts' loop
    execute format('drop policy %I on workouts', p.policyname);
  end loop;
end $$;
create policy workouts_select on workouts for select using (can_edit_workouts(participant_id));
create policy workouts_insert on workouts for insert with check (can_edit_workouts(participant_id));
create policy workouts_update on workouts for update using (can_edit_workouts(participant_id)) with check (can_edit_workouts(participant_id));
create policy workouts_delete on workouts for delete using (can_edit_workouts(participant_id));
grant select, insert, update, delete on table workouts to authenticated;

-- ---------- 2. перенос данных между аккаунтами ----------
create table if not exists account_transfers (
  code       text primary key,
  from_user  uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  used_by    uuid,
  used_at    timestamptz
);
alter table account_transfers enable row level security;   -- напрямую недоступна: только через функции ниже

-- всё, что принадлежит p_from, становится данными p_to (профиль p_to — имя, роль, код приглашения — не меняется)
create or replace function move_account_data(p_from uuid, p_to uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n_w int; n_bw int; n_food int; n_tpl int; n_ex int; n_cert int; n_fr int;
begin
  if p_from is null or p_to is null or p_from = p_to then raise exception 'Неверные аккаунты'; end if;
  update workouts set participant_id = p_to where participant_id = p_from; get diagnostics n_w = row_count;
  update workouts set created_by = p_to where created_by = p_from;
  update templates set owner_id = p_to where owner_id = p_from; get diagnostics n_tpl = row_count;
  update exercises set owner_id = p_to where owner_id = p_from; get diagnostics n_ex = row_count;
  -- вес и активность: по одной записи в день — если на новом аккаунте день уже есть, остаётся новая запись
  insert into body_weights(user_id, date, weight_kg) select p_to, date, weight_kg from body_weights where user_id = p_from
    on conflict (user_id, date) do nothing;
  get diagnostics n_bw = row_count;
  delete from body_weights where user_id = p_from;
  insert into daily_activity(user_id, date, kind, steps) select p_to, date, kind, steps from daily_activity where user_id = p_from
    on conflict (user_id, date) do nothing;
  delete from daily_activity where user_id = p_from;
  update food_log set user_id = p_to where user_id = p_from; get diagnostics n_food = row_count;
  update food_log set created_by = p_to where created_by = p_from;
  update user_achievements set user_id = p_to where user_id = p_from; get diagnostics n_cert = row_count;
  if to_regclass('public.user_badges') is not null then execute 'update user_badges set user_id = $1 where user_id = $2' using p_to, p_from; end if;
  -- личные данные: пустые поля нового аккаунта заполняются старыми
  if not exists(select 1 from profile_details where user_id = p_to) then
    update profile_details set user_id = p_to where user_id = p_from;
  else
    update profile_details t set birth_date = coalesce(t.birth_date, f.birth_date), birthday = coalesce(t.birthday, f.birthday),
      gender = coalesce(t.gender, f.gender), weight_kg = coalesce(t.weight_kg, f.weight_kg), height_cm = coalesce(t.height_cm, f.height_cm),
      goal = coalesce(t.goal, f.goal), activity = coalesce(t.activity, f.activity), kcal_goal = coalesce(t.kcal_goal, f.kcal_goal),
      kcal_target = coalesce(t.kcal_target, f.kcal_target), membership_start = coalesce(t.membership_start, f.membership_start),
      membership_end = coalesce(t.membership_end, f.membership_end), membership_term = coalesce(t.membership_term, f.membership_term),
      show_public = t.show_public or f.show_public, show_trainer = t.show_trainer or f.show_trainer
    from profile_details f where t.user_id = p_to and f.user_id = p_from;
    delete from profile_details where user_id = p_from;
  end if;
  -- участники и тренеры: связи переходят, дубли и связь «сам с собой» убираются
  delete from friendships where (requester_id = p_from and addressee_id = p_to) or (requester_id = p_to and addressee_id = p_from);
  update friendships f set requester_id = p_to where requester_id = p_from
    and not exists(select 1 from friendships x where (x.requester_id = p_to and x.addressee_id = f.addressee_id) or (x.requester_id = f.addressee_id and x.addressee_id = p_to));
  update friendships f set addressee_id = p_to where addressee_id = p_from
    and not exists(select 1 from friendships x where (x.requester_id = p_to and x.addressee_id = f.requester_id) or (x.requester_id = f.requester_id and x.addressee_id = p_to));
  delete from friendships where requester_id = p_from or addressee_id = p_from;
  get diagnostics n_fr = row_count;
  delete from trainer_links where (trainer_id = p_from and trainee_id = p_to) or (trainer_id = p_to and trainee_id = p_from);
  update trainer_links l set trainee_id = p_to where trainee_id = p_from
    and not exists(select 1 from trainer_links x where x.trainee_id = p_to and x.trainer_id = l.trainer_id);
  update trainer_links l set trainer_id = p_to where trainer_id = p_from
    and not exists(select 1 from trainer_links x where x.trainer_id = p_to and x.trainee_id = l.trainee_id);
  delete from trainer_links where trainer_id = p_from or trainee_id = p_from;
  -- годовой архив пересчитывается для нового аккаунта
  if to_regclass('public.yearly_archive') is not null then
    execute 'delete from yearly_archive where participant_id = $1' using p_from;
    begin perform refresh_yearly_archive(p_to); exception when others then null; end;
  end if;
  return jsonb_build_object('workouts', n_w, 'weights', n_bw, 'food', n_food, 'templates', n_tpl, 'exercises', n_ex, 'certificates', n_cert);
end $$;
revoke all on function move_account_data(uuid, uuid) from public, anon, authenticated;

-- старый аккаунт: получить код (действует 24 часа, новый код отменяет старый)
create or replace function create_transfer_code() returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if auth.uid() is null then raise exception 'Нет входа'; end if;
  delete from account_transfers where from_user = auth.uid() and used_at is null;
  c := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into account_transfers(code, from_user) values (c, auth.uid());
  return c;
end $$;
grant execute on function create_transfer_code() to authenticated;

-- новый аккаунт: ввести код — все данные старого переезжают сюда
create or replace function claim_transfer_code(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t account_transfers; r jsonb;
begin
  if auth.uid() is null then raise exception 'Нет входа'; end if;
  select * into t from account_transfers where code = upper(trim(p_code)) for update;
  if t.code is null or t.used_at is not null or t.expires_at < now() then raise exception 'Код не найден или устарел'; end if;
  if t.from_user = auth.uid() then raise exception 'Этот код нужно ввести в новом аккаунте, а не в том, где он создан'; end if;
  r := move_account_data(t.from_user, auth.uid());
  update account_transfers set used_by = auth.uid(), used_at = now() where code = t.code;
  return r;
end $$;
grant execute on function claim_transfer_code(text) to authenticated;

-- админ: перенос, если доступа к старому аккаунту нет
create or replace function admin_move_account(p_from uuid, p_to uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Только для администратора'; end if;
  return move_account_data(p_from, p_to);
end $$;
grant execute on function admin_move_account(uuid, uuid) to authenticated;

-- проверка: 4 строки правил для workouts
select policyname, cmd from pg_policies where tablename = 'workouts' order by policyname;
