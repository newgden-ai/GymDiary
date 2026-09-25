-- =========================================================
-- Расписание бота. Сначала: Database → Extensions → включить pg_cron и pg_net.
-- Замените ВАШ_CRON_SECRET на то же значение, что задали в секрете CRON_SECRET.
-- Время в UTC; комментарии — по Ташкенту (UTC+5).
-- =========================================================

-- удалить старые задания с теми же именами (повторный запуск безопасен)
select cron.unschedule(jobname) from cron.job where jobname in ('gd-morning','gd-motivation','gd-evening','gd-notify');

-- 08:00 — «не забудь размяться» + картинка
select cron.schedule('gd-morning', '0 3 * * *', $$
  select net.http_post(
    url := 'https://avobjimkmpdbntwxcldb.supabase.co/functions/v1/telegram-bot',
    headers := '{"Content-Type":"application/json","x-cron-secret":"ВАШ_CRON_SECRET"}'::jsonb,
    body := '{"action":"cron","kind":"morning"}'::jsonb);
$$);

-- 13:00 — мотивация, если тренировки не было больше 2 дней (не чаще раза в 3 дня)
select cron.schedule('gd-motivation', '0 8 * * *', $$
  select net.http_post(
    url := 'https://avobjimkmpdbntwxcldb.supabase.co/functions/v1/telegram-bot',
    headers := '{"Content-Type":"application/json","x-cron-secret":"ВАШ_CRON_SECRET"}'::jsonb,
    body := '{"action":"cron","kind":"motivation"}'::jsonb);
$$);

-- 21:00 — «была ли сегодня физическая активность?» (только если тренировки не было)
select cron.schedule('gd-evening', '0 16 * * *', $$
  select net.http_post(
    url := 'https://avobjimkmpdbntwxcldb.supabase.co/functions/v1/telegram-bot',
    headers := '{"Content-Type":"application/json","x-cron-secret":"ВАШ_CRON_SECRET"}'::jsonb,
    body := '{"action":"cron","kind":"evening"}'::jsonb);
$$);

-- каждые 2 минуты — уведомления о заявках в участники и тренерстве
select cron.schedule('gd-notify', '*/2 * * * *', $$
  select net.http_post(
    url := 'https://avobjimkmpdbntwxcldb.supabase.co/functions/v1/telegram-bot',
    headers := '{"Content-Type":"application/json","x-cron-secret":"ВАШ_CRON_SECRET"}'::jsonb,
    body := '{"action":"cron","kind":"notify"}'::jsonb);
$$);

-- проверить: select jobname, schedule from cron.job;
-- история запусков: select * from cron.job_run_details order by start_time desc limit 20;
