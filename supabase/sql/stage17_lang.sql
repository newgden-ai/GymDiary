-- =========================================================
-- Этап 17: язык пользователя. Приложение сохраняет выбранный язык, бот пишет на нём.
-- SQL Editor → Run. Повторный запуск безопасен.
-- =========================================================
alter table profiles add column if not exists lang text;
alter table profiles drop constraint if exists profiles_lang_check;
alter table profiles add constraint profiles_lang_check check (lang is null or lang in ('ru','uk','en','fr','es','it','uz','tr','zh','ja','ko'));

-- проверка: должна вернуться строка «lang | text»
select column_name, data_type from information_schema.columns where table_name = 'profiles' and column_name = 'lang';
