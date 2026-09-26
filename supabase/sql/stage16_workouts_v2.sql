-- =========================================================
-- Этап 16: вес тела в тренировке, дроп-сеты (3 дропа), кардио, день рождения, исправление доступа тренера.
-- SQL Editor → Run. Повторный запуск безопасен. Выполнить ДО загрузки нового index.html.
-- =========================================================

-- 1) ошибка «stack depth limit exceeded» — из-за неё тренер не видел подопечных (и их калории)
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'admin');
$$;
grant execute on function is_admin() to authenticated;

-- 2) вес тела, записанный в тренировке (из него строится статистика веса)
alter table workouts add column if not exists body_weight numeric check (body_weight is null or body_weight between 20 and 400);

-- 3) настоящая дата рождения (ачивка «в день рождения» — только по ней, а не по возрасту)
alter table profile_details add column if not exists birthday date;

-- 4) тоннаж на сервере (архив, админ-статистика): вес × повторения + дропы дроп-сета
create or replace function calc_workout_tonnage(blocks jsonb)
returns numeric language sql immutable as $$
  select coalesce(sum(
    case when (s->>'weight') ~ '^[0-9]+(\.[0-9]+)?$' and (s->>'reps') ~ '^[0-9]+(\.[0-9]+)?$'
         then (s->>'weight')::numeric * (s->>'reps')::numeric else 0 end
    + case when coalesce((ex->>'isDropset')::boolean, false) or coalesce((s->>'isDrop')::boolean, false) then coalesce((
        select sum((d->>'weight')::numeric * (d->>'reps')::numeric) from jsonb_array_elements(coalesce(s->'drops','[]'::jsonb)) d
        where (d->>'weight') ~ '^[0-9]+(\.[0-9]+)?$' and (d->>'reps') ~ '^[0-9]+(\.[0-9]+)?$'), 0) else 0 end
  ), 0)
  from jsonb_array_elements(coalesce(blocks,'[]'::jsonb)) b,
       jsonb_array_elements(coalesce(b->'exercises','[]'::jsonb)) ex,
       jsonb_array_elements(coalesce(ex->'sets','[]'::jsonb)) s;
$$;

-- 5) кардио: общие упражнения (время, км, уклон)
create or replace function _gd_ex(p_name text, p_group text, p_type text) returns text
language plpgsql as $$
declare v uuid;
begin
  select id into v from exercises where owner_id is null and lower(name) = lower(p_name) limit 1;
  if v is null then insert into exercises(owner_id, name, main_group, type) values (null, p_name, p_group, p_type) returning id into v; end if;
  return v::text;
end $$;
select _gd_ex('Бег', 'other', 'cardio'), _gd_ex('Ходьба', 'other', 'cardio'), _gd_ex('Плавание', 'other', 'cardio'),
       _gd_ex('Велосипед', 'other', 'cardio'), _gd_ex('Велотренажёр', 'other', 'cardio'), _gd_ex('Эллипс', 'other', 'cardio'),
       _gd_ex('Гребля', 'back', 'cardio'), _gd_ex('Степпер', 'glutes', 'cardio');

-- 6) ачивки друзей: вес тела из тренировок тоже нужен для расчёта
create or replace function friend_achievement_data(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); ws jsonb; ex jsonb; bw jsonb; see boolean;
begin
  if me is null then raise exception 'Нет входа'; end if;
  if not (p_user = me or are_friends(p_user, me) or exists(select 1 from trainer_links tl where tl.active and
      ((tl.trainer_id = me and tl.trainee_id = p_user) or (tl.trainee_id = me and tl.trainer_id = p_user)))) then
    raise exception 'Нет доступа';
  end if;
  see := can_see_details(p_user);
  select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'participant_id', w.participant_id, 'date', w.date, 'time', w.time,
           'duration', w.duration, 'type', w.type, 'status', w.status, 'blocks', w.blocks,
           'body_weight', case when see then w.body_weight end) order by w.date), '[]'::jsonb)
    into ws from workouts w where w.participant_id = p_user and w.date <= current_date;
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'main_group', e.main_group,
           'secondary_groups', e.secondary_groups, 'type', e.type, 'owner_id', e.owner_id)), '[]'::jsonb)
    into ex from exercises e where e.id::text in (
      select distinct x->>'exerciseId' from workouts w, jsonb_array_elements(w.blocks) b, jsonb_array_elements(b->'exercises') x
      where w.participant_id = p_user);
  if see then
    select coalesce(jsonb_agg(jsonb_build_object('user_id', b.user_id, 'date', b.date, 'weight_kg', b.weight_kg)), '[]'::jsonb)
      into bw from body_weights b where b.user_id = p_user;
  else bw := '[]'::jsonb; end if;
  return jsonb_build_object('workouts', ws, 'exercises', ex, 'weights', bw);
end $$;
grant execute on function friend_achievement_data(uuid) to authenticated;

-- проверка
select calc_workout_tonnage('[{"exercises":[{"isDropset":true,"sets":[{"weight":72.5,"reps":8,"drops":[{"weight":60,"reps":6}]}]}]}]'::jsonb) as "должно быть 940";
