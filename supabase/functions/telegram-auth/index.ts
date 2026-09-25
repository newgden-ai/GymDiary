// supabase/functions/telegram-bot/index.ts
//
// Один обработчик на три источника запросов:
//  1) Telegram webhook (заголовок X-Telegram-Bot-Api-Secret-Token = BOT_WEBHOOK_SECRET):
//     /start и анкета (возраст, пол, вес, рост, цель, приватность), ответы про активность за день.
//  2) Приложение: { action: "workout_done", workout_id } + Authorization: Bearer <сессия пользователя>
//     → итог тренировки участнику и его тренерам.
//  3) Расписание (pg_cron, заголовок x-cron-secret = CRON_SECRET): { action: "cron", kind }
//     kind: "morning" — зарядка, "evening" — вопрос об активности, "motivation" — >2 дней без тренировок,
//           "notify" — отправка накопленных уведомлений (заявки в друзья, тренерство).
//
// Секреты (supabase secrets set ...): TELEGRAM_BOT_TOKEN, BOT_WEBHOOK_SECRET, CRON_SECRET,
//   MINI_APP_URL (адрес index.html, напр. https://newgden-ai.github.io/GymDiary/), APP_TZ (по умолчанию Asia/Tashkent).
// Деплой: supabase functions deploy telegram-bot --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("BOT_WEBHOOK_SECRET") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const APP_URL = (Deno.env.get("MINI_APP_URL") ?? "").replace(/\/?$/, "/").replace(/index\.html\/$/, "");
const TZ = Deno.env.get("APP_TZ") ?? "Asia/Tashkent";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, apikey, authorization" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------------- Telegram API ----------------
async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.log("TG_ERROR", method, JSON.stringify(j));
  return j;
}
const send = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id, text, parse_mode: "HTML", ...extra });
const kb = (rows: [string, string][][]) => ({ reply_markup: { inline_keyboard: rows.map((r) => r.map(([text, callback_data]) => ({ text, callback_data }))) } });
const appKb = (text = "📒 Открыть дневник") => APP_URL ? { reply_markup: { inline_keyboard: [[{ text, web_app: { url: APP_URL } }]] } } : {};
const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// ---------------- тексты ----------------
const MORNING = [
  "Доброе утро! ☀️ Не забудь размяться: 5 минут — и тело скажет спасибо.",
  "Подъём! Пара наклонов, вращения плечами и 10 приседаний — отличный старт дня 💪",
  "Утренняя зарядка — это не про спорт, это про бодрость. Начни с шеи и плеч 🙂",
  "Потянись как следует! Руки вверх, глубокий вдох — и 20 лёгких прыжков на месте.",
  "Минутка для суставов: вращения кистями, локтями, плечами, тазом, коленями и стопами.",
  "Кошка-корова 10 раз и планка 30 секунд — спина будет благодарна весь день.",
  "Сделай 3 круга: 10 приседаний, 10 отжиманий от стены, 20 секунд планки. Погнали! 🔥",
  "Не залипай в телефон — вставай и разгоняй кровь: 30 «джампинг-джеков» и пара выпадов.",
  "Чем бодрее утро, тем продуктивнее день. 5 минут растяжки прямо сейчас? ✅",
  "Разминка — лучший кофе. Наклоны, повороты корпуса, махи руками — и вперёд к целям!",
];
const MOTIVATION = [
  "Уже несколько дней без тренировки. Мышцы скучают — даже 20 минут сегодня лучше, чем ничего 💪",
  "Помнишь, зачем ты начинал? Один шаг — одна тренировка. Сегодня отличный день, чтобы вернуться!",
  "Форма не уходит за пару дней, но привычка — уходит. Запланируй тренировку прямо сейчас 📅",
  "Лучшая тренировка — та, которая состоялась. Даже лёгкая. Погнали? 🔥",
  "Дисциплина побеждает мотивацию. Надень кроссовки — остальное приложится 👟",
  "Твой будущий «я» скажет спасибо за сегодняшнюю тренировку. Не подводи его!",
  "Перерыв — это нормально. Возвращение — это сила. Жду твою следующую тренировку 💪",
  "Небольшая цель на сегодня: 15 минут движения. Справишься? Уверен, что да!",
  "Прогресс любит регулярность. Два дня отдыха были, пора снова в бой 🏋️",
  "Light weight, baby! Штанга сама себя не поднимет 😉",
];
const MORNING_IMAGES = Array.from({ length: 10 }, (_, i) => `${APP_URL}bot/morning/${String(i + 1).padStart(2, "0")}.png`);

const GOALS: [string, string][] = [
  ["lose", "Похудеть"], ["mass", "Набрать мышечную массу"], ["strength", "Стать сильнее"],
  ["endurance", "Выносливость"], ["health", "Здоровье и тонус"], ["rehab", "Восстановление после травмы"], ["other", "Другое"],
];
const ACTIVITIES: [string, string][] = [
  ["work", "😮‍💨 Тяжёлый рабочий день, нет сил"], ["steps", "🚶 Много шагов за день"],
  ["moving", "📦 Переезд / закупки, таскал тяжёлое"], ["house", "🧹 Уборка, дача, работа по дому"],
  ["outdoor", "🚴 Прогулка, велосипед, плавание"], ["sport", "⚽ Игры, танцы, спорт с друзьями"],
  ["kids", "👶 Дети / выгул собаки"], ["sick", "🤒 Болею / восстанавливаюсь"], ["other", "✍️ Другое"],
];

// ---------------- профиль ----------------
async function ensureProfile(from: { id: number; first_name?: string; last_name?: string; username?: string }) {
  const { data: existing } = await admin.from("profiles").select("*").eq("telegram_id", from.id).maybeSingle();
  if (existing) return existing;
  // человек сначала написал боту, а приложение ещё не открывал — создаём пользователя так же, как telegram-auth
  const email = `tg${from.id}@telegram.trendnevnik.local`;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "Без имени";
  const { data: created, error } = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { telegram_id: from.id, telegram_username: from.username } });
  let id = created?.user?.id;
  if (!id) { // пользователь есть в auth, но без профиля
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    id = list?.users.find((u) => u.email === email)?.id;
    if (!id) throw new Error("createUser: " + error?.message);
  }
  await admin.from("profiles").insert({ id, telegram_id: from.id, telegram_username: from.username ?? null, name });
  const { data } = await admin.from("profiles").select("*").eq("id", id).single();
  return data;
}
// ошибки базы не глотаем: иначе бот «не помнит» шаг анкеты и задаёт один и тот же вопрос по кругу
const must = async (p: PromiseLike<{ error: any }>, what: string) => {
  const { error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
};
const setState = (id: string, state: Record<string, unknown>) => must(admin.from("profiles").update({ bot_state: state }).eq("id", id), "profiles.bot_state");
const saveDetails = (id: string, patch: Record<string, unknown>) =>
  must(admin.from("profile_details").upsert({ user_id: id, ...patch, updated_at: new Date().toISOString() }, { onConflict: "user_id" }), "profile_details");

// ---------------- анкета ----------------
async function askAge(chat: number, id: string) {
  await setState(id, { step: "age" });
  await send(chat, "Сколько вам лет? Напишите число.");
}
async function askGender(chat: number, id: string) {
  await setState(id, { step: "gender" });
  await send(chat, "Ваш пол:", kb([[["👨 Мужской", "g:male"], ["👩 Женский", "g:female"]]]));
}
async function askGoal(chat: number, id: string) {
  await setState(id, { step: "goal" });
  await send(chat, "Какая у вас цель занятий?", kb(GOALS.map(([k, t]) => [[t, "goal:" + k]])));
}
async function askPrivacy(chat: number, id: string) {
  await setState(id, { step: "privacy" });
  await send(chat,
    "Кто может видеть ваши данные (возраст, пол, вес, рост, цель)?\nПо умолчанию — только вы. Изменить можно в приложении: Участники → вы → «Личные данные».",
    kb([[["🔒 Только я", "priv:me"]], [["🏋️ Я и мой тренер", "priv:trainer"]], [["👥 Все мои участники", "priv:all"]]]));
}

async function onMessage(msg: any) {
  if (!msg.from || msg.chat?.type !== "private") return;
  const chat = msg.chat.id as number;
  const text = String(msg.text ?? "").trim();
  const p = await ensureProfile(msg.from);
  const st = (p.bot_state ?? {}) as Record<string, any>;

  if (text.startsWith("/start")) {
    if (!p.onboarded) {
      await send(chat, `Привет, ${esc(p.name)}! 👋 Я бот «ТренДневника».\nЗадам 6 коротких вопросов — это займёт минуту. Эти данные видите только вы, пока сами не решите иначе.`);
      return askAge(chat, p.id);
    }
    await setState(p.id, {});
    return send(chat, `С возвращением, ${esc(p.name)}! Записывайте тренировки в дневнике 👇\n\n/profile — заново заполнить анкету\n/reminders — вкл/выкл напоминания`, appKb());
  }
  if (text === "/profile") return askAge(chat, p.id);
  if (text === "/reminders") {
    const on = !p.reminders;
    await admin.from("profiles").update({ reminders: on }).eq("id", p.id);
    return send(chat, on ? "🔔 Напоминания включены." : "🔕 Напоминания выключены. Включить снова — /reminders");
  }

  const num = Number(text.replace(",", ".").replace(/[^\d.]/g, ""));
  switch (st.step) {
    case "age":
      if (!(num >= 7 && num <= 100)) return send(chat, "Напишите возраст числом, например: 29");
      { const d = new Date(); d.setFullYear(d.getFullYear() - Math.floor(num)); await saveDetails(p.id, { birth_date: d.toISOString().slice(0, 10) }); }
      return askGender(chat, p.id);
    case "weight":
      if (!(num >= 20 && num <= 350)) return send(chat, "Напишите вес в килограммах, например: 72.5");
      await saveDetails(p.id, { weight_kg: num });
      await admin.from("body_weights").upsert({ user_id: p.id, date: today(), weight_kg: num }, { onConflict: "user_id,date" });
      await setState(p.id, { step: "height" });
      return send(chat, "Ваш рост в сантиметрах?");
    case "height":
      if (!(num >= 90 && num <= 250)) return send(chat, "Напишите рост в сантиметрах, например: 178");
      await saveDetails(p.id, { height_cm: num });
      return askGoal(chat, p.id);
    case "goal_other":
      if (!text) return send(chat, "Опишите цель в паре слов.");
      await saveDetails(p.id, { goal: text.slice(0, 200) });
      return askPrivacy(chat, p.id);
    case "steps":
      if (!(num >= 0 && num <= 200000)) return send(chat, "Напишите количество шагов числом, например: 12000");
      await admin.from("daily_activity").upsert({ user_id: p.id, date: st.date ?? today(), kind: "steps", steps: Math.round(num) }, { onConflict: "user_id,date" });
      await setState(p.id, {});
      return send(chat, num >= 10000 ? `🔥 ${Math.round(num).toLocaleString("ru-RU")} шагов — отличный результат! Записал.` : `Записал: ${Math.round(num).toLocaleString("ru-RU")} шагов 👍`);
  }
  if (["gender", "goal", "privacy", "activity", "activity_q"].includes(st.step)) return send(chat, "Выберите вариант кнопкой в сообщении выше 👆");
  if (!p.onboarded) return askAge(chat, p.id);
  return send(chat, "Дневник тренировок — в приложении 👇", appKb());
}

async function onCallback(cb: any) {
  const chat = cb.message?.chat?.id as number;
  const data = String(cb.data ?? "");
  await tg("answerCallbackQuery", { callback_query_id: cb.id });
  if (cb.message) await tg("editMessageReplyMarkup", { chat_id: chat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  const p = await ensureProfile(cb.from);
  const st = (p.bot_state ?? {}) as Record<string, any>;
  const [key, val] = data.split(":");

  if (key === "g") {
    await saveDetails(p.id, { gender: val === "female" ? "female" : "male" });
    await setState(p.id, { step: "weight" });
    return send(chat, "Ваш вес в килограммах?");
  }
  if (key === "goal") {
    if (val === "other") { await setState(p.id, { step: "goal_other" }); return send(chat, "Напишите свою цель в паре слов."); }
    await saveDetails(p.id, { goal: GOALS.find(([k]) => k === val)?.[1] ?? val });
    return askPrivacy(chat, p.id);
  }
  if (key === "priv") {
    await saveDetails(p.id, { show_public: val === "all", show_trainer: val === "all" || val === "trainer" });
    await admin.from("profiles").update({ onboarded: true, bot_state: {} }).eq("id", p.id);
    return send(chat, "Готово! ✅ Анкета сохранена.\nЯ буду присылать итоги тренировок, утренние напоминания о зарядке и иногда спрашивать про активность. Выключить напоминания — /reminders", appKb());
  }
  if (key === "act") {
    const date = st.date ?? today();
    if (val === "no") {
      await admin.from("daily_activity").upsert({ user_id: p.id, date, kind: "none" }, { onConflict: "user_id,date" });
      await setState(p.id, {});
      return send(chat, "Понял. Отдых тоже часть прогресса 😌 Завтра — новый день!");
    }
    await setState(p.id, { step: "activity", date });
    return send(chat, "Отлично! Какая была активность?", kb(ACTIVITIES.map(([k, t]) => [[t, "actk:" + k]])));
  }
  if (key === "actk") {
    const date = st.date ?? today();
    await admin.from("daily_activity").upsert({ user_id: p.id, date, kind: val }, { onConflict: "user_id,date" });
    if (val === "steps") { await setState(p.id, { step: "steps", date }); return send(chat, "Сколько шагов прошли за день?"); }
    await setState(p.id, {});
    const reply: Record<string, string> = {
      work: "Бывает. Восстановление важно — выспись как следует 😴",
      moving: "Это тоже серьёзная нагрузка! Засчитано 💪", sick: "Выздоравливай! Тренировки подождут 🙏",
    };
    return send(chat, reply[val] ?? "Записал! Любое движение — в копилку 👍");
  }
}

// ---------------- итог тренировки ----------------
const TONNAGE_CMP: [number, string][] = [[50, "кот 🐈"], [200, "пианино 🎹"], [800, "мотоцикл 🏍️"], [1500, "легковой автомобиль 🚗"], [3000, "внедорожник 🚙"],
  [5000, "белый носорог 🦏"], [7000, "слон 🐘"], [9000, "мини-экскаватор 🚜"], [15000, "городской автобус 🚌"], [25000, "строительный экскаватор 🏗️"],
  [40000, "грузовик-фура 🚛"], [60000, "башенный кран 🏗️"], [100000, "синий кит 🐋"]];
const MG: Record<string, string> = { chest: "Грудь", back: "Спина", shoulders: "Плечи", biceps: "Бицепс", triceps: "Трицепс", forearms: "Предплечья",
  quads: "Квадрицепс", hamstrings: "Бицепс бедра", glutes: "Ягодицы", calves: "Икры", abs: "Пресс", other: "Другое" };
const fmt = (n: number) => Math.round(n).toLocaleString("ru-RU");

async function workoutSummary(w: any) {
  const ids = new Set<string>();
  (w.blocks ?? []).forEach((b: any) => (b.exercises ?? []).forEach((e: any) => ids.add(e.exerciseId)));
  const { data: exs } = ids.size ? await admin.from("exercises").select("id,name,main_group").in("id", [...ids]) : { data: [] };
  const info = new Map((exs ?? []).map((e: any) => [e.id, e]));
  let total = 0, sets = 0; const groups: Record<string, number> = {}; const lines: string[] = [];
  for (const b of w.blocks ?? []) for (const e of b.exercises ?? []) {
    let t = 0, n = 0;
    for (const s of e.sets ?? []) { const v = (Number(s.weight) || 0) * (Number(s.reps) || 0); if (v > 0 || Number(s.reps) > 0 || s.time) n++; t += v; }
    const ex: any = info.get(e.exerciseId);
    if (!n) continue;
    sets += n; total += t;
    if (ex && t > 0) groups[ex.main_group] = (groups[ex.main_group] ?? 0) + t;
    lines.push(`• ${esc(ex?.name ?? "Упражнение")}${b.kind === "superset" ? " (суперсет)" : e.isDropset ? " (дроп-сет)" : ""}: ${n} подх.${t > 0 ? `, ${fmt(t)} кг` : ""}`);
  }
  const cmp = [...TONNAGE_CMP].reverse().find(([th]) => total >= th);
  const g = Object.entries(groups).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${MG[k] ?? k} ${fmt(v)}`).join(" · ");
  return [
    `🏋️ <b>${esc(w.name || "Тренировка")}</b>`,
    `📅 ${w.date}${w.duration ? ` · ⏱ ${w.duration} мин` : ""}`,
    lines.length ? lines.join("\n") : "Подходы не заполнены",
    `\nПодходов: <b>${sets}</b>${total > 0 ? ` · Тоннаж: <b>${fmt(total)} кг</b>` : ""}`,
    cmp ? `Это как поднять: ${cmp[1]}` : "",
    g ? `По группам: ${g}` : "",
    w.result ? `Самочувствие: ${esc(w.result)}` : "",
  ].filter(Boolean).join("\n");
}

async function onWorkoutDone(req: Request, body: any) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json({ error: "not authorized" }, 401);
  const { data: w } = await admin.from("workouts").select("*").eq("id", body.workout_id).maybeSingle();
  if (!w) return json({ error: "workout not found" }, 404);
  const me = u.user.id;
  const { data: links } = await admin.from("trainer_links").select("trainer_id").eq("trainee_id", w.participant_id).eq("active", true);
  const isTrainer = (links ?? []).some((l: any) => l.trainer_id === me);
  if (w.participant_id !== me && w.created_by !== me && !isTrainer) return json({ error: "forbidden" }, 403);

  const text = await workoutSummary(w);
  const { data: people } = await admin.from("profiles").select("id,name,telegram_id").in("id", [w.participant_id, ...(links ?? []).map((l: any) => l.trainer_id)]);
  const athlete = (people ?? []).find((x: any) => x.id === w.participant_id);
  if (athlete?.telegram_id) await send(athlete.telegram_id, "✅ Тренировка завершена!\n\n" + text, appKb("📒 Открыть дневник"));
  for (const t of (people ?? []).filter((x: any) => x.id !== w.participant_id && x.telegram_id))
    await send(t.telegram_id, `👀 Подопечный <b>${esc(athlete?.name)}</b> завершил тренировку:\n\n` + text);
  return json({ ok: true });
}

// ---------------- расписание ----------------
async function recipients() {
  const { data } = await admin.from("profiles").select("id,name,telegram_id,reminders,last_evening_date,last_motivation_date,created_at,bot_state").not("telegram_id", "is", null).eq("reminders", true);
  return data ?? [];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cron(kind: string) {
  let sent = 0;
  if (kind === "notify") {
    const { data: list } = await admin.from("notifications").select("*").eq("telegram_sent", false).order("created_at").limit(200);
    for (const n of list ?? []) {
      const ids = [n.user_id, n.payload?.from].filter(Boolean);
      const { data: ps } = await admin.from("profiles").select("id,name,telegram_id").in("id", ids);
      const to = ps?.find((x: any) => x.id === n.user_id), from = ps?.find((x: any) => x.id === n.payload?.from);
      const who = `<b>${esc(from?.name ?? "Участник")}</b>`;
      const text: Record<string, string> = {
        friend_request: `📨 ${who} хочет добавить вас в участники. Ответьте в разделе «Участники».`,
        friend_accepted: `🤝 ${who} подтвердил(а) заявку — теперь вы участники друг у друга.`,
        trainer_offer: `🏋️ ${who} предлагает стать вашим тренером. Принять или отклонить можно в разделе «Участники».`,
        trainer_assigned: `✅ ${who} принял(а) вас как тренера. Его (её) тренировки теперь в вашем календаре.`,
      };
      if (to?.telegram_id && text[n.type]) { await send(to.telegram_id, text[n.type], appKb()); sent++; await sleep(40); }
      await admin.from("notifications").update({ telegram_sent: true }).eq("id", n.id);
    }
    return sent;
  }

  const users = await recipients();
  const d = today();
  for (const p of users) {
    try {
      if (kind === "morning") {
        const r = await tg("sendPhoto", { chat_id: p.telegram_id, photo: pick(MORNING_IMAGES), caption: pick(MORNING) });
        if (!r.ok) await send(p.telegram_id, pick(MORNING)); // картинка недоступна — шлём только текст
        sent++;
      } else if (kind === "evening") {
        if (p.last_evening_date === d) continue;
        const [{ count: w }, { count: a }] = await Promise.all([
          admin.from("workouts").select("id", { count: "exact", head: true }).eq("participant_id", p.id).eq("date", d).eq("status", "done"),
          admin.from("daily_activity").select("id", { count: "exact", head: true }).eq("user_id", p.id).eq("date", d),
        ]);
        if ((w ?? 0) > 0 || (a ?? 0) > 0) continue;
        await admin.from("profiles").update({ last_evening_date: d, bot_state: { step: "activity_q", date: d } }).eq("id", p.id);
        await send(p.telegram_id, "Сегодня тренировки не было. Была ли какая-то физическая активность за день?", kb([[["👍 Да", "act:yes"], ["👎 Нет", "act:no"]]]));
        sent++;
      } else if (kind === "motivation") {
        const border = today(-3); // тренировки не было больше 2 дней
        if (p.last_motivation_date && p.last_motivation_date > today(-3)) continue;
        if (p.created_at.slice(0, 10) > border) continue;
        const { data: last } = await admin.from("workouts").select("date").eq("participant_id", p.id).eq("status", "done").lte("date", d).order("date", { ascending: false }).limit(1);
        if (last?.[0] && last[0].date > border) continue;
        await admin.from("profiles").update({ last_motivation_date: d }).eq("id", p.id);
        await send(p.telegram_id, pick(MOTIVATION), appKb("📅 Запланировать тренировку"));
        sent++;
      }
    } catch (e) { console.log("CRON_USER_ERROR", p.id, String(e)); }
    await sleep(40); // лимит Telegram ~30 сообщений/сек
  }
  return sent;
}

// ---------------- вход ----------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.headers.get("x-telegram-bot-api-secret-token") !== null) {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const upd = await req.json();
      const chatId = upd.message?.chat?.id ?? upd.callback_query?.message?.chat?.id;
      try {
        if (upd.message) await onMessage(upd.message);
        else if (upd.callback_query) await onCallback(upd.callback_query);
      } catch (e) {
        console.log("BOT_UPDATE_ERROR", String(e));
        if (chatId) await send(chatId, "⚠️ Не удалось сохранить ответ — ошибка базы данных:\n<code>" + esc(String(e).slice(0, 300)) + "</code>\nСообщите администратору.");
      }
      return new Response("ok");
    }
    const body = await req.json().catch(() => ({}));
    if (body.action === "workout_done") return await onWorkoutDone(req, body);
    if (body.action === "cron") {
      if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return json({ error: "forbidden" }, 403);
      return json({ ok: true, sent: await cron(String(body.kind)) });
    }
    return json({ error: "unknown request" }, 400);
  } catch (e) {
    console.log("BOT_ERROR", String(e));
    // Telegram должен получить 200, иначе будет бесконечно повторять апдейт
    return req.headers.get("x-telegram-bot-api-secret-token") ? new Response("ok") : json({ error: String(e) }, 500);
  }
});
