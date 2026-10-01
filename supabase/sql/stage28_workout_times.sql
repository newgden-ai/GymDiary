-- =========================================================
-- Этап 28: время начала и окончания тренировки.
-- «▶ Начать тренировку» записывает started_at, «Завершить тренировку» — finished_at и длительность.
-- По ним в «Календаре» видно идущую тренировку, и её можно продолжить с того же места.
-- Запускать до загрузки нового index.html. Повторный запуск безопасен.
-- =========================================================
alter table workouts add column if not exists started_at timestamptz;
alter table workouts add column if not exists finished_at timestamptz;

select count(*) filter (where started_at is not null) as "начато кнопкой", count(*) as "всего тренировок" from workouts;
