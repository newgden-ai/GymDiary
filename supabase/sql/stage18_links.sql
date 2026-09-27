-- =========================================================
-- Этап 18: ссылки внизу страниц (поддержать автора, рекомендованные блогеры).
-- Заполняются в приложении: Настройки → Админ-панель → «Ссылки внизу страниц». Видят все, менять может только админ.
-- SQL Editor → Run. Повторный запуск безопасен.
-- =========================================================
create table if not exists app_links (
  id         uuid primary key default gen_random_uuid(),
  section    text not null check (section in ('support','bloggers')),
  kind       text not null default 'other' check (kind in ('boosty','youtube','instagram','telegram','tiktok','vk','site','other')),
  title      text not null check (length(title) between 1 and 80),
  url        text not null check (url ~ '^https://' and length(url) <= 500),
  note       text check (note is null or length(note) <= 200),
  sort       int  not null default 0,
  created_at timestamptz not null default now()
);
-- заголовки и вступительный текст блоков
create table if not exists app_texts (
  key   text primary key check (key in ('support_title','support_intro','bloggers_title','bloggers_intro')),
  value text not null check (length(value) <= 500)
);

alter table app_links enable row level security;
alter table app_texts enable row level security;
drop policy if exists app_links_read on app_links;
drop policy if exists app_links_admin on app_links;
drop policy if exists app_texts_read on app_texts;
drop policy if exists app_texts_admin on app_texts;
create policy app_links_read  on app_links for select using (true);
create policy app_links_admin on app_links for all using (is_admin()) with check (is_admin());
create policy app_texts_read  on app_texts for select using (true);
create policy app_texts_admin on app_texts for all using (is_admin()) with check (is_admin());
grant select, insert, update, delete on table app_links, app_texts to authenticated;

-- тексты по умолчанию (потом меняются в админ-панели)
insert into app_texts(key, value) values
  ('support_title',  'Поддержать автора'),
  ('support_intro',  'Если вы хотите помочь автору приложения, можете воспользоваться:'),
  ('bloggers_title', 'Блогеры, рекомендованные автором'),
  ('bloggers_intro', '')
on conflict (key) do nothing;

-- проверка: 2 строки (app_links, app_texts)
select table_name from information_schema.tables where table_name in ('app_links','app_texts') order by 1;
