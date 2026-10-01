-- =========================================================
-- Этап 28: время начала и окончания тренировки + таймер отдыха по умолчанию 2 минуты.
-- «▶ Начать тренировку» записывает started_at, «Завершить тренировку» — finished_at и длительность.
-- По ним в «Календаре» видно идущую тренировку, и её можно продолжить с того же места.
-- Запускать до загрузки нового index.html. Повторный запуск безопасен.
-- =========================================================
alter table workouts add column if not exists started_at timestamptz;
alter table workouts add column if not exists finished_at timestamptz;

select count(*) filter (where started_at is not null) as "начато кнопкой", count(*) as "всего тренировок" from workouts;

-- таймер отдыха по умолчанию — 2 минуты (у кого стояло старое значение по умолчанию 90 с — тоже 2 минуты; свои значения не меняются)
alter table profiles alter column rest_default set default 120;
update profiles set rest_default = 120 where rest_default is null or rest_default = 90;
