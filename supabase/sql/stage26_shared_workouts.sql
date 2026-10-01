-- =========================================================
-- Этап 26: «Показать тренировку друзьям».
-- В тренировке появилась галочка — такие тренировки (название, упражнения, подходы, тоннаж, самочувствие)
-- видят друзья в профиле человека. Остальные тренировки друзьям по-прежнему не видны (только для расчёта ачивок, без названий).
-- Запускать после stage24. Повторный запуск безопасен.
-- =========================================================
alter table workouts add column if not exists shared boolean not null default false;

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
           'body_weight', case when see or w.shared then w.body_weight end,
           'shared', w.shared,
           'name', case when w.shared then w.name end,
           'result', case when w.shared then w.result end) order by w.date), '[]'::jsonb)
    into ws from workouts w where w.participant_id = p_user and w.date <= current_date;
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'main_group', e.main_group,
           'secondary_groups', e.secondary_groups, 'type', e.type, 'owner_id', e.owner_id, 'image_url', e.image_url,
           'bodyweight', e.bodyweight)), '[]'::jsonb)
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

select count(*) filter (where shared) as "показано друзьям", count(*) as "всего тренировок" from workouts;
