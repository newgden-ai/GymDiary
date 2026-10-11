-- =========================================================
-- Этап 30: тарифы Free / Pro / Тренер, оплата звёздами Telegram и коды подписки от администратора.
-- Повторный запуск безопасен.
--  * subscriptions      — у кого какой тариф и до какого числа (пишет бот после оплаты или redeem_promo)
--  * promo_codes        — коды, которые админ раздаёт себе и тестерам (тариф + сколько дней + сколько активаций)
--  * promo_redemptions  — кто какой код уже активировал
--  * app_texts: paywall = on/off (пока off — всё бесплатно для всех), price_pro / price_trainer — цена в звёздах в месяц
-- =========================================================

create table if not exists subscriptions (
  user_id    uuid primary key references profiles(id) on delete cascade,
  plan       text not null check (plan in ('pro','trainer')),
  until      timestamptz not null,
  source     text not null default 'stars' check (source in ('stars','promo','admin')),
  charge_id  text,
  updated_at timestamptz not null default now()
);
alter table subscriptions enable row level security;
drop policy if exists subscriptions_read on subscriptions;
create policy subscriptions_read on subscriptions for select using (user_id = auth.uid() or is_admin());
grant select on table subscriptions to authenticated;   -- менять может только бот (service role) и функции ниже

create table if not exists promo_codes (
  code       text primary key check (code ~ '^[A-Z0-9-]{4,32}$'),
  plan       text not null check (plan in ('pro','trainer')),
  days       int  not null check (days between 1 and 3650),
  max_uses   int  not null default 1 check (max_uses between 1 and 10000),
  uses       int  not null default 0,
  note       text check (length(note) <= 200),
  expires_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists promo_redemptions (
  code    text references promo_codes(code) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  at      timestamptz not null default now(),
  primary key (code, user_id)
);
alter table promo_codes enable row level security;
alter table promo_redemptions enable row level security;
drop policy if exists promo_codes_admin on promo_codes;
drop policy if exists promo_red_read on promo_redemptions;
create policy promo_codes_admin on promo_codes for all using (is_admin()) with check (is_admin());
create policy promo_red_read on promo_redemptions for select using (user_id = auth.uid() or is_admin());
grant select, insert, update, delete on table promo_codes to authenticated;
grant select on table promo_redemptions to authenticated;

-- активация кода пользователем: дни прибавляются к текущей подписке; тренерский тариф не понижается до Pro
create or replace function redeem_promo(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c promo_codes; s subscriptions; v_until timestamptz; v_plan text;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into c from promo_codes where code = upper(trim(p_code)) for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if c.expires_at is not null and c.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'expired'); end if;
  if c.uses >= c.max_uses then return jsonb_build_object('ok', false, 'error', 'used_up'); end if;
  if exists (select 1 from promo_redemptions where code = c.code and user_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'already'); end if;
  select * into s from subscriptions where user_id = auth.uid();
  v_plan  := case when s.plan = 'trainer' and s.until > now() then 'trainer' else c.plan end;
  v_until := greatest(coalesce(s.until, now()), now()) + make_interval(days => c.days);
  insert into subscriptions(user_id, plan, until, source, updated_at) values (auth.uid(), v_plan, v_until, 'promo', now())
  on conflict (user_id) do update set plan = excluded.plan, until = excluded.until, source = 'promo', updated_at = now();
  insert into promo_redemptions(code, user_id) values (c.code, auth.uid());
  update promo_codes set uses = uses + 1 where code = c.code;
  return jsonb_build_object('ok', true, 'plan', v_plan, 'until', v_until);
end $$;
revoke all on function redeem_promo(text) from public, anon;
grant execute on function redeem_promo(text) to authenticated;

-- выключатель платного режима и цены (звёзды в месяц). Тренер 400⭐ ≈ 5 $
alter table app_texts drop constraint if exists app_texts_key_check;
alter table app_texts add constraint app_texts_key_check check (key in
  ('support_title','support_intro','bloggers_title','bloggers_intro','paywall','price_pro','price_trainer'));
insert into app_texts(key, value) values ('paywall','off'), ('price_pro','200'), ('price_trainer','400')
on conflict (key) do nothing;
