-- =========================================================
-- Этап 23: безопасность данных. Явные правила доступа для таблиц, которые создавались при первой настройке
-- (их правила не были записаны в файлах проекта), и защита служебных полей.
-- Запускать после stage22. SQL Editor → Run. Повторный запуск безопасен.
-- Что закрывает:
--  • нельзя самому себе поставить роль admin, сменить telegram_id или код приглашения;
--  • профили видят только сам человек, его участники/тренер и админ (раньше правило могло быть «видят все»);
--  • нельзя слать уведомления (сообщения бота) другим людям напрямую;
--  • общие упражнения меняет только админ; чужие свои упражнения не видны;
--  • заявки в друзья и связи с тренером меняются только через проверенные функции (нельзя «принять» тренерство за подопечного);
--  • сертификат нельзя переписать на другого человека.
-- =========================================================

-- снять все старые правила таблицы (имена правил первой настройки неизвестны)
create or replace function _gd_drop_policies(t text) returns void language plpgsql as $$
declare p record; begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
    execute format('drop policy %I on %I', p.policyname, t);
  end loop;
end $$;

-- ---------- профили ----------
select _gd_drop_policies('profiles');
alter table profiles enable row level security;
create policy profiles_select on profiles for select using (
  id = auth.uid() or is_admin() or are_friends(id, auth.uid())
  or exists(select 1 from friendships f where (f.requester_id = auth.uid() and f.addressee_id = profiles.id) or (f.addressee_id = auth.uid() and f.requester_id = profiles.id))
  or exists(select 1 from trainer_links tl where (tl.trainer_id = auth.uid() and tl.trainee_id = profiles.id) or (tl.trainee_id = auth.uid() and tl.trainer_id = profiles.id)));
create policy profiles_update on profiles for update using (id = auth.uid() or is_admin()) with check (id = auth.uid() or is_admin());
-- создаёт и удаляет профили только сервер (вход через Telegram, бот) — правил insert/delete для пользователей нет

-- служебные поля профиля меняет только сервер (роль service_role) или владелец базы из SQL Editor
create or replace function profiles_guard() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then raise exception 'Профиль создаётся только при входе через Telegram'; end if;
    new.id := old.id; new.role := old.role; new.telegram_id := old.telegram_id; new.telegram_username := old.telegram_username;
    new.invite_code := old.invite_code; new.bot_state := old.bot_state; new.onboarded := old.onboarded;
    new.last_evening_date := old.last_evening_date; new.last_motivation_date := old.last_motivation_date;
  end if;
  return new;
end $$;
drop trigger if exists trg_profiles_guard on profiles;
create trigger trg_profiles_guard before insert or update on profiles for each row execute function profiles_guard();

-- ---------- уведомления: читать свои; создают их только функции и триггеры базы ----------
select _gd_drop_policies('notifications');
alter table notifications enable row level security;
create policy notifications_select on notifications for select using (user_id = auth.uid() or is_admin());
revoke insert, update, delete on table notifications from authenticated, anon;

-- ---------- упражнения ----------
select _gd_drop_policies('exercises');
alter table exercises enable row level security;
create policy exercises_select on exercises for select using (
  owner_id is null or owner_id = auth.uid() or is_admin()
  or exists(select 1 from trainer_links tl where tl.trainer_id = auth.uid() and tl.trainee_id = exercises.owner_id and tl.active));
create policy exercises_insert on exercises for insert with check (owner_id = auth.uid() or (owner_id is null and is_admin()) or is_admin());
create policy exercises_update on exercises for update using (owner_id = auth.uid() or is_admin()) with check (owner_id = auth.uid() or is_admin());
create policy exercises_delete on exercises for delete using (owner_id = auth.uid() or is_admin());

-- ---------- заявки в друзья и тренерство: читать свои, менять — только через функции add_friend_by_code, respond_* и т. п. ----------
select _gd_drop_policies('friendships');
alter table friendships enable row level security;
create policy friendships_select on friendships for select using (requester_id = auth.uid() or addressee_id = auth.uid() or is_admin());
create policy friendships_delete on friendships for delete using (requester_id = auth.uid() or addressee_id = auth.uid() or is_admin());

select _gd_drop_policies('trainer_links');
alter table trainer_links enable row level security;
create policy trainer_links_select on trainer_links for select using (trainer_id = auth.uid() or trainee_id = auth.uid() or is_admin());
create policy trainer_links_delete on trainer_links for delete using (trainer_id = auth.uid() or trainee_id = auth.uid() or is_admin());

-- ---------- сертификаты: свои создаёт/удаляет сам человек, подтверждает админ ----------
select _gd_drop_policies('user_achievements');
alter table user_achievements enable row level security;
create policy user_achievements_select on user_achievements for select using (user_id = auth.uid() or is_admin() or (status = 'approved' and can_see_details(user_id)));
create policy user_achievements_insert on user_achievements for insert with check (user_id = auth.uid() or is_admin());
create policy user_achievements_update on user_achievements for update using (user_id = auth.uid() or is_admin()) with check (user_id = auth.uid() or is_admin());
create policy user_achievements_delete on user_achievements for delete using ((user_id = auth.uid() and status <> 'approved') or is_admin());
-- владельца сертификата не переписать (к защите статуса и ачивок из этапа 19)
create or replace function user_achievements_keep_owner() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') and not is_admin() then new.user_id := old.user_id; end if;
  return new;
end $$;
drop trigger if exists trg_user_achievements_keep_owner on user_achievements;
create trigger trg_user_achievements_keep_owner before update on user_achievements for each row execute function user_achievements_keep_owner();

-- ---------- служебные функции: вызывать напрямую нельзя ----------
revoke all on function _gd_drop_policies(text) from public, anon, authenticated;

-- проверка: правила по таблицам
select tablename, policyname, cmd from pg_policies
where tablename in ('profiles','notifications','exercises','friendships','trainer_links','user_achievements','workouts') order by 1, 2;
