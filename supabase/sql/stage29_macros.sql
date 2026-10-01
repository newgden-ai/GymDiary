-- =========================================================
-- Этап 29: своё соотношение БЖУ на кг веса тела (белок и жиры, г/кг; углеводы — остаток калорий).
-- Повторный запуск безопасен.
-- =========================================================
alter table profile_details add column if not exists protein_per_kg numeric(3,1);
alter table profile_details add column if not exists fat_per_kg numeric(3,1);

create or replace function set_food_norm(p_user uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare d profile_details;
begin
  if auth.uid() is null or not can_edit_food(p_user) then raise exception 'Нет доступа к дневнику'; end if;
  if p_patch ? 'kcal_goal' and coalesce(p_patch->>'kcal_goal','') not in ('lose','keep','gain') then raise exception 'Неверная цель'; end if;
  if p_patch ? 'activity' and coalesce(p_patch->>'activity','') not in ('1.2','1.375','1.55','1.725','1.9') then raise exception 'Неверная активность'; end if;
  if p_patch ? 'protein_per_kg' and nullif(p_patch->>'protein_per_kg','') is not null and (p_patch->>'protein_per_kg')::numeric not between 0.5 and 4 then raise exception 'Белок: от 0,5 до 4 г/кг'; end if;
  if p_patch ? 'fat_per_kg' and nullif(p_patch->>'fat_per_kg','') is not null and (p_patch->>'fat_per_kg')::numeric not between 0.3 and 3 then raise exception 'Жиры: от 0,3 до 3 г/кг'; end if;
  insert into profile_details(user_id) values (p_user) on conflict (user_id) do nothing;
  update profile_details set
    kcal_goal      = case when p_patch ? 'kcal_goal'      then p_patch->>'kcal_goal' else kcal_goal end,
    activity       = case when p_patch ? 'activity'       then p_patch->>'activity' else activity end,
    kcal_target    = case when p_patch ? 'kcal_target'    then nullif(p_patch->>'kcal_target','')::int else kcal_target end,
    protein_per_kg = case when p_patch ? 'protein_per_kg' then nullif(p_patch->>'protein_per_kg','')::numeric else protein_per_kg end,
    fat_per_kg     = case when p_patch ? 'fat_per_kg'     then nullif(p_patch->>'fat_per_kg','')::numeric else fat_per_kg end
  where user_id = p_user returning * into d;
  if p_user <> auth.uid() then
    insert into notifications(user_id, type, payload) values (p_user, 'food_norm', jsonb_build_object(
      'from', auth.uid(), 'goal', d.kcal_goal, 'activity', d.activity, 'target', d.kcal_target));
  end if;
end $$;
grant execute on function set_food_norm(uuid, jsonb) to authenticated;

select count(*) filter (where protein_per_kg is not null or fat_per_kg is not null) as "своё БЖУ", count(*) as "всего" from profile_details;
