-- =========================================================
-- Этап 25: отчёт за день приходит в 00:00 (по Ташкенту, UTC+5) + секрет расписания хранится в Vault, а не в коде.
-- Итоги питания за прошедший день и итоги недели / месяца / квартала / года отправляет задание gd-daily.
--
-- ОДИН РАЗ перед запуском положите секрет в хранилище (то же значение, что в секрете функции CRON_SECRET):
--   Supabase → Project Settings → Vault → Add new secret: Name = cron_secret, Secret = <ваш CRON_SECRET>
--   (или в SQL Editor: select vault.create_secret('<ваш CRON_SECRET>', 'cron_secret');  — этот запрос не сохраняйте в файлы)
-- Сам файл секрета не содержит — его можно хранить на GitHub. Повторный запуск безопасен.
-- Все задания бота пересоздаются так, чтобы брали секрет из Vault (старые с секретом в тексте удаляются).
-- =========================================================

do $$ begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'cron_secret') then
    raise exception 'Сначала добавьте секрет cron_secret в Vault (Project Settings → Vault)';
  end if;
end $$;

select cron.unschedule(jobname) from cron.job
where jobname in ('gd-morning','gd-motivation','gd-evening','gd-notify','gd-daily');

-- общий вызов бота: секрет читается из Vault в момент запуска
create or replace function gd_call_bot(p_kind text) returns bigint
language sql security definer set search_path = public as $$
  select net.http_post(
    url := 'https://avobjimkmpdbntwxcldb.supabase.co/functions/v1/telegram-bot',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := jsonb_build_object('action', 'cron', 'kind', p_kind));
$$;
revoke all on function gd_call_bot(text) from public, anon, authenticated;

select cron.schedule('gd-morning',    '0 3 * * *',   $$select gd_call_bot('morning')$$);     -- 08:00 зарядка
select cron.schedule('gd-motivation', '0 8 * * *',   $$select gd_call_bot('motivation')$$);  -- 13:00 мотивация
select cron.schedule('gd-evening',    '0 16 * * *',  $$select gd_call_bot('evening')$$);     -- 21:00 вопрос об активности
select cron.schedule('gd-daily',      '0 19 * * *',  $$select gd_call_bot('daily')$$);       -- 00:00 отчёт за день и периоды
select cron.schedule('gd-notify',     '*/2 * * * *', $$select gd_call_bot('notify')$$);      -- уведомления каждые 2 мин

select jobname, schedule, command from cron.job where jobname like 'gd-%' order by jobname;
