-- =========================================================
-- Этап 20: уведомления о сертификатах.
-- Пользователь: «сертификат отправлен на проверку». Админ: «пришёл сертификат на проверку» (бот присылает фото сертификата).
-- Запускать после stage19_cert_badges.sql. SQL Editor → Run. Повторный запуск безопасен.
-- =========================================================
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check check (type in
  ('friend_request','friend_accepted','trainer_offer','trainer_assigned','achievement_pending','achievement_approved',
   'achievement_rejected','workout_result','food_changed','food_norm','achievement_badge','achievement_submitted'));

create or replace function user_achievements_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare b custom_badges;
begin
  if new.badge_id is not null then select * into b from custom_badges where id = new.badge_id; end if;
  if tg_op = 'INSERT' and new.status = 'pending' then
    -- админам: пришёл сертификат на проверку (бот приложит фото)
    insert into notifications(user_id, type, payload)
      select p.id, 'achievement_pending', jsonb_build_object('from', new.user_id, 'cert_id', new.id, 'name', new.competition_name,
             'result', new.result, 'date', new.competition_date, 'place', new.competition_place)
      from profiles p where p.role = 'admin';
    -- самому пользователю: сертификат отправлен
    insert into notifications(user_id, type, payload)
      values (new.user_id, 'achievement_submitted', jsonb_build_object('cert_id', new.id, 'name', new.competition_name));
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('approved','rejected') then
    insert into notifications(user_id, type, payload)
      values (new.user_id, case when new.status='approved' then 'achievement_approved' else 'achievement_rejected' end,
              jsonb_build_object('cert_id', new.id, 'name', new.competition_name, 'comment', new.review_comment,
                                 'badge_title', b.title, 'badge_desc', b.description, 'badge_img', b.image_url));
  elsif tg_op = 'UPDATE' and new.status = 'approved' and new.badge_id is distinct from old.badge_id and new.badge_id is not null then
    insert into notifications(user_id, type, payload)
      values (new.user_id, 'achievement_badge', jsonb_build_object('cert_id', new.id, 'name', new.competition_name,
                                 'badge_title', b.title, 'badge_desc', b.description, 'badge_img', b.image_url));
  end if;
  return null;
end $$;

-- проверка: должно вернуться «ok»
select 'ok' where exists (select 1 from pg_proc where proname = 'user_achievements_notify');
