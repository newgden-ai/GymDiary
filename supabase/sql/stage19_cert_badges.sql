-- =========================================================
-- Этап 19: свои ачивки за соревнования. Админ при подтверждении сертификата (или позже)
-- выбирает ачивку из библиотеки или загружает новую картинку — без программирования.
-- SQL Editor → Run. Повторный запуск безопасен.
-- =========================================================

-- библиотека ачивок: картинка + название + описание (одну ачивку можно выдавать многим, например всем участникам турнира)
create table if not exists custom_badges (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(title) between 1 and 80),
  description text check (description is null or length(description) <= 300),
  image_url   text not null check (image_url ~ '^https://' and length(image_url) <= 600),
  created_at  timestamptz not null default now()
);
alter table custom_badges enable row level security;
drop policy if exists custom_badges_read on custom_badges;
drop policy if exists custom_badges_admin on custom_badges;
create policy custom_badges_read  on custom_badges for select using (true);
create policy custom_badges_admin on custom_badges for all using (is_admin()) with check (is_admin());
grant select, insert, update, delete on table custom_badges to authenticated;

-- какая ачивка выдана за сертификат
alter table user_achievements add column if not exists badge_id uuid references custom_badges(id) on delete set null;

-- пользователь не может сам себе выдать ачивку или подтвердить сертификат
create or replace function user_achievements_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    new.status := 'pending'; new.reviewed_at := null; new.reviewed_by := null; new.review_comment := null; new.badge_id := null;
  end if;
  return new;
end $$;
create or replace function user_achievements_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    new.status := old.status; new.reviewed_at := old.reviewed_at; new.reviewed_by := old.reviewed_by;
    new.review_comment := old.review_comment; new.badge_id := old.badge_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_user_achievements_before_update on user_achievements;
create trigger trg_user_achievements_before_update before update on user_achievements
  for each row execute function user_achievements_before_update();

-- уведомления: к подтверждению — картинка ачивки; ачивку выдали позже — отдельное сообщение
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check check (type in
  ('friend_request','friend_accepted','trainer_offer','trainer_assigned','achievement_pending','achievement_approved',
   'achievement_rejected','workout_result','food_changed','food_norm','achievement_badge'));

create or replace function user_achievements_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare b custom_badges;
begin
  if new.badge_id is not null then select * into b from custom_badges where id = new.badge_id; end if;
  if tg_op = 'INSERT' and new.status = 'pending' then
    insert into notifications(user_id, type, payload)
      select p.id, 'achievement_pending', jsonb_build_object('from', new.user_id, 'cert_id', new.id, 'name', new.competition_name)
      from profiles p where p.role = 'admin';
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

-- ---- хранилище картинок ачивок: открыто для просмотра, загружает только админ ----
insert into storage.buckets (id, name, public) values ('badges', 'badges', true) on conflict (id) do update set public = true;
drop policy if exists badges_read on storage.objects;
create policy badges_read on storage.objects for select using (bucket_id = 'badges');
drop policy if exists badges_upload on storage.objects;
create policy badges_upload on storage.objects for insert to authenticated with check (bucket_id = 'badges' and public.is_admin());
drop policy if exists badges_update on storage.objects;
create policy badges_update on storage.objects for update to authenticated using (bucket_id = 'badges' and public.is_admin());
drop policy if exists badges_delete on storage.objects;
create policy badges_delete on storage.objects for delete to authenticated using (bucket_id = 'badges' and public.is_admin());

-- проверка: должна вернуться строка «badge_id | uuid»
select column_name, data_type from information_schema.columns where table_name = 'user_achievements' and column_name = 'badge_id';
