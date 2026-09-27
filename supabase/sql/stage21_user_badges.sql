-- =========================================================
-- Этап 21: выданные ачивки. За сертификат — сколько угодно ачивок; персональные ачивки — любому пользователю.
-- Запускать после stage19 и stage20. SQL Editor → Run. Повторный запуск безопасен.
-- =========================================================
create table if not exists user_badges (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  badge_id   uuid not null references custom_badges(id) on delete cascade,
  cert_id    uuid references user_achievements(id) on delete cascade,   -- null — персональная ачивка
  note       text check (note is null or length(note) <= 300),          -- за что (для персональной)
  given_by   uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists idx_user_badges_user on user_badges(user_id);

alter table user_badges enable row level security;
drop policy if exists user_badges_read on user_badges;
drop policy if exists user_badges_admin on user_badges;
-- видят: сам человек, админ и те, кому он открыл личные данные (как сертификаты)
create policy user_badges_read  on user_badges for select using (user_id = auth.uid() or is_admin() or can_see_details(user_id));
create policy user_badges_admin on user_badges for all using (is_admin()) with check (is_admin());
grant select, insert, update, delete on table user_badges to authenticated;

-- перенос: ачивки, уже выданные за сертификаты одним полем (этап 19)
insert into user_badges(user_id, badge_id, cert_id)
  select a.user_id, a.badge_id, a.id from user_achievements a
  where a.badge_id is not null and not exists (select 1 from user_badges u where u.cert_id = a.id and u.badge_id = a.badge_id);

-- уведомление в бот о каждой выданной ачивке (с картинкой)
create or replace function user_badges_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare b custom_badges; c user_achievements;
begin
  select * into b from custom_badges where id = new.badge_id;
  if new.cert_id is not null then select * into c from user_achievements where id = new.cert_id; end if;
  insert into notifications(user_id, type, payload)
    values (new.user_id, 'achievement_badge', jsonb_build_object('cert_id', new.cert_id, 'name', c.competition_name, 'note', new.note,
            'badge_title', b.title, 'badge_desc', b.description, 'badge_img', b.image_url));
  return null;
end $$;
drop trigger if exists trg_user_badges_notify on user_badges;
create trigger trg_user_badges_notify after insert on user_badges for each row execute function user_badges_notify();

-- старое одиночное поле больше не шлёт своё уведомление (иначе было бы два сообщения)
create or replace function user_achievements_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    insert into notifications(user_id, type, payload)
      select p.id, 'achievement_pending', jsonb_build_object('from', new.user_id, 'cert_id', new.id, 'name', new.competition_name,
             'result', new.result, 'date', new.competition_date, 'place', new.competition_place)
      from profiles p where p.role = 'admin';
    insert into notifications(user_id, type, payload)
      values (new.user_id, 'achievement_submitted', jsonb_build_object('cert_id', new.id, 'name', new.competition_name));
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('approved','rejected') then
    insert into notifications(user_id, type, payload)
      values (new.user_id, case when new.status='approved' then 'achievement_approved' else 'achievement_rejected' end,
              jsonb_build_object('cert_id', new.id, 'name', new.competition_name, 'comment', new.review_comment));
  end if;
  return null;
end $$;

-- проверка: должно вернуться число выданных ачивок (0 — если ещё не выдавали)
select count(*) as user_badges from user_badges;
