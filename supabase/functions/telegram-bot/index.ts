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
import { BOT_I18N } from "./i18n.ts";

// номер сборки: бот называет его по /version и пишет в лог — сразу видно, развернулась ли новая версия
const BOT_VERSION = "2026-09-27 · badges";
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("BOT_WEBHOOK_SECRET") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const APP_URL = (Deno.env.get("MINI_APP_URL") ?? "").replace(/\/?$/, "/").replace(/index\.html\/$/, "");
const TZ = Deno.env.get("APP_TZ") ?? "Asia/Tashkent";
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
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
// фото: сначала по ссылке; если Telegram не смог скачать — качаем сами и отправляем файлом;
// если и так не вышло — отправляем текст с пометкой, какая ссылка не открылась (видно, что чинить)
async function sendPhotoSafe(chat_id: number, url: string, caption: string, extra: Record<string, unknown> = {}) {
  const r = await tg("sendPhoto", { chat_id, photo: url, caption, parse_mode: "HTML", ...extra });
  if (r.ok) return { ok: true, how: "url" };
  let status = 0;
  try {
    const img = await fetch(url); status = img.status;
    if (img.ok) {
      const fd = new FormData();
      fd.append("chat_id", String(chat_id)); fd.append("caption", caption); fd.append("parse_mode", "HTML");
      if (extra.reply_markup) fd.append("reply_markup", JSON.stringify(extra.reply_markup));
      fd.append("photo", new Blob([await img.arrayBuffer()], { type: img.headers.get("content-type") ?? "image/jpeg" }), url.split("/").pop() ?? "photo.jpg");
      const up = await (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: "POST", body: fd })).json();
      if (up.ok) return { ok: true, how: "upload" };
      console.log("TG_UPLOAD_ERROR", JSON.stringify(up));
    }
  } catch (e) { console.log("IMG_FETCH_ERROR", url, String(e)); }
  await send(chat_id, caption + `\n\n<i>(картинка не загрузилась: ${esc(url)} — ${status || "нет ответа"})</i>`, extra);
  return { ok: false, status };
}
const kb = (rows: [string, string][][]) => ({ reply_markup: { inline_keyboard: rows.map((r) => r.map(([text, callback_data]) => ({ text, callback_data }))) } });
const appKb = (text = "📒 Открыть дневник", lang = "ru") => APP_URL ? { reply_markup: { inline_keyboard: [[{ text: L(lang, text), web_app: { url: APP_URL } }]] } } : {};
const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

// ---------------- языки ----------------
// язык человека: выбранный в приложении (profiles.lang) → язык Telegram → русский; тексты — в i18n.ts (ключ = русская фраза)
const LANGS = ["ru", "uk", "en", "fr", "es", "it", "uz", "tr", "zh", "ja", "ko"];
const LOCALE: Record<string, string> = { ru: "ru-RU", uk: "uk-UA", en: "en-GB", fr: "fr-FR", es: "es-ES", it: "it-IT", uz: "uz-Latn-UZ", tr: "tr-TR", zh: "zh-CN", ja: "ja-JP", ko: "ko-KR" };
function normLang(code?: string | null) {
  const c = String(code ?? "").toLowerCase().split(/[-_]/)[0];
  if (LANGS.includes(c)) return c;
  return ["be", "kk", "ky", "tg", "hy", "az", "ka", "tt", "ba"].includes(c) || !c ? "ru" : "en";
}
const langOf = (p: any, from?: any) => p?.lang && LANGS.includes(p.lang) ? p.lang : normLang(from?.language_code);
// L(lang, "Русская фраза {x}", {x}) — перевод + подстановка
function L(lang: string, ru: string, v: Record<string, unknown> = {}) {
  const t = (lang !== "ru" && BOT_I18N[lang]?.[ru]) || ru;
  return t.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m));
}

function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// ---------------- тексты ----------------
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
// утренняя картинка и подпись — парой (bot/morning/NN.jpg)
const MORNING_SET: [string, string][] = [
  ["01", "Доброе утро! ☀️ Потянись: руки вверх и 5 глубоких вдохов — тело просыпается."],
  ["02", "Доброе утро! Вращения плечами и наклоны в стороны — по 10–15 повторений в каждую сторону 💪"],
  ["03", "Подъём! 30 «джампинг-джеков» — и кровь побежала быстрее 🔥"],
  ["04", "Доброе утро! Выпады — по 8 на каждую ногу. Спокойно, без рывков."],
  ["05", "Доброе утро! Планка 30 секунд: живот подтянут, спина ровная ⏱"],
  ["06", "Доброе утро! Наклон вперёд: тянемся к носкам 20 секунд, колени мягкие."],
  ["07", "Кошка-корова 10–15 плавных повторов — спина будет благодарна весь день 🐱🐮"],
  ["08", "Доброе утро! Шаг на месте 1 минуту, колени высоко — разгоняем пульс 👟"],
  ["09", "Не залипай в телефон — вставай! Шаг на месте 1 минуту, колени высоко."],
  ["10", "Утренний комплекс на 5 минут: потянись, плечи, наклоны, приседания, прыжки, выпады, планка, наклон вперёд, кошка-корова, шаг на месте ✅"],
];

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
async function askAge(chat: number, id: string, lang: string) {
  await setState(id, { step: "age" });
  await send(chat, L(lang, "Сколько вам лет? Напишите число."));
}
async function askGender(chat: number, id: string, lang: string) {
  await setState(id, { step: "gender" });
  await send(chat, L(lang, "Ваш пол:"), kb([[[L(lang, "👨 Мужской"), "g:male"], [L(lang, "👩 Женский"), "g:female"]]]));
}
async function askGoal(chat: number, id: string, lang: string) {
  await setState(id, { step: "goal" });
  await send(chat, L(lang, "Какая у вас цель занятий?"), kb(GOALS.map(([k, t]) => [[L(lang, t), "goal:" + k]])));
}
async function askPrivacy(chat: number, id: string, lang: string) {
  await setState(id, { step: "privacy" });
  await send(chat,
    L(lang, "Кто может видеть ваши данные (возраст, пол, вес, рост, цель)?\nПо умолчанию — только вы. Изменить можно в приложении: Участники → вы → «Личные данные»."),
    kb([[[L(lang, "🔒 Только я"), "priv:me"]], [[L(lang, "🏋️ Я и мой тренер"), "priv:trainer"]], [[L(lang, "👥 Все мои участники"), "priv:all"]]]));
}
// язык ещё не сохранён — запоминаем язык Telegram (в приложении его можно сменить)
async function withLang(p: any, from: any) {
  if (!p.lang) { p.lang = normLang(from?.language_code); await admin.from("profiles").update({ lang: p.lang }).eq("id", p.id); }
  return langOf(p, from);
}

async function onMessage(msg: any) {
  if (!msg.from || msg.chat?.type !== "private") return;
  const chat = msg.chat.id as number;
  const text = String(msg.text ?? "").trim().replace(/^(\/\w+)@\w+/, "$1");  // /cmd@имя_бота → /cmd
  console.log("BOT_MESSAGE", BOT_VERSION, text.slice(0, 40));
  const p = await ensureProfile(msg.from);
  const lang = await withLang(p, msg.from);
  const st = (p.bot_state ?? {}) as Record<string, any>;

  if (text.startsWith("/start")) {
    if (!p.onboarded) {
      await send(chat, L(lang, "Привет, {name}! 👋 Я бот «ТренДневника».\nЗадам 6 коротких вопросов — это займёт минуту. Эти данные видите только вы, пока сами не решите иначе.", { name: esc(p.name) }));
      return askAge(chat, p.id, lang);
    }
    await setState(p.id, {});
    return send(chat, L(lang, "С возвращением, {name}! Записывайте тренировки в дневнике 👇\n\n/profile — заново заполнить анкету\n/reminders — вкл/выкл напоминания", { name: esc(p.name) }), appKb(undefined, lang));
  }
  if (text === "/profile") return askAge(chat, p.id, lang);
  if (text === "/report") {   // проверить отчёт: итоги последних 7 дней
    const d = today(); const cur = await periodStats(p.id, addDays(d, -6), d);
    return send(chat, L(lang, "📊 Последние 7 дней: тренировок <b>{n}</b>, тоннаж <b>{ton} кг</b>{cardio}.\nПолные итоги придут в воскресенье, в конце месяца, квартала и года в 21:00.",
      { n: cur.n, ton: fmt(cur.ton, lang), cardio: cur.km ? L(lang, ", кардио {km} км", { km: Math.round(cur.km * 10) / 10 }) : "" }));
  }
  if (text === "/version") return send(chat, `Версия бота / Bot version: <b>${BOT_VERSION}</b>\nMINI_APP_URL: <code>${esc(APP_URL || "—")}</code>\nlang: ${lang}`);
  if (text === "/test_images") {
    if (!APP_URL) return send(chat, "⚠️ Секрет MINI_APP_URL не задан — боту неоткуда брать картинки.");
    await send(chat, `Проверяю картинки по адресу приложения:\n<code>${esc(APP_URL)}</code>`);
    const a = await sendPhotoSafe(chat, `${APP_URL}img/lightweight/01.jpg`, "Тест: постер Light weight");
    const b = await sendPhotoSafe(chat, `${APP_URL}bot/morning/01.jpg`, "Тест: утренняя картинка");
    const c = await sendPhotoSafe(chat, `${APP_URL}img/weak/01.jpg`, "Тест: «Ну давай, заплачь!!!»");
    return send(chat, a.ok && b.ok && c.ok ? "✅ Картинки доступны." : "❌ Часть картинок недоступна — проверьте, что папки img/ и bot/ запушены и MINI_APP_URL указывает на адрес приложения.");
  }
  if (text === "/reminders") {
    const on = !p.reminders;
    await admin.from("profiles").update({ reminders: on }).eq("id", p.id);
    return send(chat, on ? L(lang, "🔔 Напоминания включены.") : L(lang, "🔕 Напоминания выключены. Включить снова — /reminders"));
  }

  const num = Number(text.replace(",", ".").replace(/[^\d.]/g, ""));
  switch (st.step) {
    case "age":
      if (!(num >= 7 && num <= 100)) return send(chat, L(lang, "Напишите возраст числом, например: 29"));
      { const d = new Date(); d.setFullYear(d.getFullYear() - Math.floor(num)); await saveDetails(p.id, { birth_date: d.toISOString().slice(0, 10) }); }
      return askGender(chat, p.id, lang);
    case "weight":
      if (!(num >= 20 && num <= 350)) return send(chat, L(lang, "Напишите вес в килограммах, например: 72.5"));
      await saveDetails(p.id, { weight_kg: num });
      await admin.from("body_weights").upsert({ user_id: p.id, date: today(), weight_kg: num }, { onConflict: "user_id,date" });
      await setState(p.id, { step: "height" });
      return send(chat, L(lang, "Ваш рост в сантиметрах?"));
    case "height":
      if (!(num >= 90 && num <= 250)) return send(chat, L(lang, "Напишите рост в сантиметрах, например: 178"));
      await saveDetails(p.id, { height_cm: num });
      return askGoal(chat, p.id, lang);
    case "goal_other":
      if (!text) return send(chat, L(lang, "Опишите цель в паре слов."));
      await saveDetails(p.id, { goal: text.slice(0, 200) });
      return askPrivacy(chat, p.id, lang);
    case "steps":
      if (!(num >= 0 && num <= 200000)) return send(chat, L(lang, "Напишите количество шагов числом, например: 12000"));
      await admin.from("daily_activity").upsert({ user_id: p.id, date: st.date ?? today(), kind: "steps", steps: Math.round(num) }, { onConflict: "user_id,date" });
      await setState(p.id, {});
      return send(chat, num >= 10000 ? L(lang, "🔥 {n} шагов — отличный результат! Записал.", { n: fmt(num, lang) }) : L(lang, "Записал: {n} шагов 👍", { n: fmt(num, lang) }));
  }
  if (["gender", "goal", "privacy", "activity", "activity_q"].includes(st.step)) return send(chat, L(lang, "Выберите вариант кнопкой в сообщении выше 👆"));
  if (!p.onboarded) return askAge(chat, p.id, lang);
  return send(chat, L(lang, "Дневник тренировок — в приложении 👇"), appKb(undefined, lang));
}

async function onCallback(cb: any) {
  const chat = cb.message?.chat?.id as number;
  const data = String(cb.data ?? "");
  await tg("answerCallbackQuery", { callback_query_id: cb.id });
  if (cb.message) await tg("editMessageReplyMarkup", { chat_id: chat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  const p = await ensureProfile(cb.from);
  const lang = await withLang(p, cb.from);
  const st = (p.bot_state ?? {}) as Record<string, any>;
  const [key, val] = data.split(":");

  if (key === "g") {
    await saveDetails(p.id, { gender: val === "female" ? "female" : "male" });
    await setState(p.id, { step: "weight" });
    return send(chat, L(lang, "Ваш вес в килограммах?"));
  }
  if (key === "goal") {
    if (val === "other") { await setState(p.id, { step: "goal_other" }); return send(chat, L(lang, "Напишите свою цель в паре слов.")); }
    await saveDetails(p.id, { goal: GOALS.find(([k]) => k === val)?.[1] ?? val });   // в базе — русская формулировка, приложение переводит
    return askPrivacy(chat, p.id, lang);
  }
  if (key === "priv") {
    await saveDetails(p.id, { show_public: val === "all", show_trainer: val === "all" || val === "trainer" });
    await admin.from("profiles").update({ onboarded: true, bot_state: {} }).eq("id", p.id);
    return send(chat, L(lang, "Готово! ✅ Анкета сохранена.\nЯ буду присылать итоги тренировок, утренние напоминания о зарядке и иногда спрашивать про активность. Выключить напоминания — /reminders"), appKb(undefined, lang));
  }
  if (key === "act") {
    const date = st.date ?? today();
    if (val === "no") {
      await admin.from("daily_activity").upsert({ user_id: p.id, date, kind: "none" }, { onConflict: "user_id,date" });
      await setState(p.id, {});
      return send(chat, L(lang, "Понял. Отдых тоже часть прогресса 😌 Завтра — новый день!"));
    }
    await setState(p.id, { step: "activity", date });
    return send(chat, L(lang, "Отлично! Какая была активность?"), kb(ACTIVITIES.map(([k, t]) => [[L(lang, t), "actk:" + k]])));
  }
  if (key === "actk") {
    const date = st.date ?? today();
    await admin.from("daily_activity").upsert({ user_id: p.id, date, kind: val }, { onConflict: "user_id,date" });
    if (val === "steps") { await setState(p.id, { step: "steps", date }); return send(chat, L(lang, "Сколько шагов прошли за день?")); }
    await setState(p.id, {});
    const reply: Record<string, string> = {
      work: "Бывает. Восстановление важно — выспись как следует 😴",
      moving: "Это тоже серьёзная нагрузка! Засчитано 💪", sick: "Выздоравливай! Тренировки подождут 🙏",
    };
    return send(chat, L(lang, reply[val] ?? "Записал! Любое движение — в копилку 👍"));
  }
}

// ---------------- итог тренировки ----------------
const TONNAGE_CMP: [number, string][] = [[50, "кот 🐈"], [200, "пианино 🎹"], [800, "мотоцикл 🏍️"], [1500, "легковой автомобиль 🚗"], [3000, "внедорожник 🚙"],
  [5000, "белый носорог 🦏"], [7000, "слон 🐘"], [9000, "мини-экскаватор 🚜"], [15000, "городской автобус 🚌"], [25000, "строительный экскаватор 🏗️"],
  [40000, "грузовик-фура 🚛"], [60000, "башенный кран 🏗️"], [100000, "синий кит 🐋"]];
const MG: Record<string, string> = { chest: "Грудь", back: "Спина", shoulders: "Плечи", biceps: "Бицепс", triceps: "Трицепс", forearms: "Предплечья",
  quads: "Квадрицепс", hamstrings: "Бицепс бедра", glutes: "Ягодицы", calves: "Икры", abs: "Пресс", other: "Другое" };
const fmt = (n: number, lang = "ru") => Math.round(n).toLocaleString(LOCALE[lang] ?? "ru-RU");
const exName = (lang: string, n?: string) => L(lang, n ?? "Упражнение");   // базовые упражнения переведены, свои — как записаны

async function workoutSummary(w: any, lang = "ru") {
  const ids = new Set<string>();
  (w.blocks ?? []).forEach((b: any) => (b.exercises ?? []).forEach((e: any) => ids.add(e.exerciseId)));
  const { data: exs } = ids.size ? await admin.from("exercises").select("id,name,main_group,type").in("id", [...ids]) : { data: [] };
  const info = new Map((exs ?? []).map((e: any) => [e.id, e]));
  // собственный вес на дату тренировки: подход без веса = повторения × вес спортсмена (как в приложении)
  const { data: bwRow } = await admin.from("body_weights").select("weight_kg").eq("user_id", w.participant_id).lte("date", w.date).order("date", { ascending: false }).limit(1);
  let bw = Number(w.body_weight) || Number(bwRow?.[0]?.weight_kg) || 0;   // вес тела, записанный в самой тренировке, — главный
  if (!bw) { const { data: d } = await admin.from("profile_details").select("weight_kg").eq("user_id", w.participant_id).maybeSingle(); bw = Number(d?.weight_kg) || 0; }
  let total = 0, sets = 0; const groups: Record<string, number> = {}; const lines: string[] = [];
  for (const b of w.blocks ?? []) for (const e of b.exercises ?? []) {
    let t = 0, n = 0;
    const ex: any = info.get(e.exerciseId);
    const ownBw = ex && ["strength", "functional"].includes(ex.type) ? bw : 0;
    let km = 0, min = 0, incl = 0, best: { wt: number; r: number } | null = null;
    for (const s of e.sets ?? []) {
      const bw0 = Number(s.weight) || 0, br = Number(s.reps) || 0;
      if (br > 0 && (!best || bw0 > best.wt || (bw0 === best.wt && br > best.r))) best = { wt: bw0, r: br };
      const wt = Number(s.weight) || 0; let v = (wt > 0 ? wt : ownBw) * (Number(s.reps) || 0);
      // дроп-сет: к подходу прибавляются дропы (вес × повторения каждого)
      if (e.isDropset || s.isDrop) for (const d of s.drops ?? []) { const dw = Number(d.weight) || 0; v += (dw > 0 ? dw : ownBw) * (Number(d.reps) || 0); }
      if (v > 0 || Number(s.reps) > 0 || Number(s.time) > 0 || Number(s.distance) > 0) n++;
      t += v; km += Number(s.distance) || 0; min += Number(s.time) || 0; incl = Math.max(incl, Number(s.incline) || 0);
    }
    if (!n) continue;
    sets += n; total += t;
    if (ex && t > 0) groups[ex.main_group] = (groups[ex.main_group] ?? 0) + t;
    const cardio = ex?.type === "cardio" ? [km ? L(lang, "{v} км", { v: Math.round(km * 100) / 100 }) : "", min ? L(lang, "{v} мин", { v: Math.round(min) }) : "", incl ? L(lang, "уклон {v}%", { v: incl }) : ""].filter(Boolean).join(", ") : "";
    const bestTxt = ex?.type === "cardio" ? "" : best ? L(lang, " · лучший: <b>{v}</b>", { v: best.wt > 0 ? `${Math.round(best.wt * 10) / 10}×${best.r}` : L(lang, "{n} повт.", { n: best.r }) }) : "";
    lines.push(`• ${esc(exName(lang, ex?.name))}${b.kind === "superset" ? L(lang, " (суперсет)") : e.isDropset ? L(lang, " (дроп-сет)") : ""}: ${cardio || L(lang, "{n} подх.", { n })}${t > 0 ? `, ${fmt(t, lang)} ${L(lang, "кг")}` : ""}${bestTxt}`);
  }
  const cmp = [...TONNAGE_CMP].reverse().find(([th]) => total >= th);
  const g = Object.entries(groups).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${L(lang, MG[k] ?? k)} ${fmt(v, lang)}`).join(" · ");
  const kg = L(lang, "кг");
  return [
    `🏋️ <b>${esc(w.name ? L(lang, w.name) : L(lang, "Тренировка"))}</b>`,
    `📅 ${w.date}${w.duration ? ` · ⏱ ${L(lang, "{v} мин", { v: w.duration })}` : ""}${Number(w.body_weight) ? ` · ⚖️ ${w.body_weight} ${kg}` : ""}`,
    lines.length ? lines.join("\n") : L(lang, "Подходы не заполнены"),
    "\n" + L(lang, "Подходов: <b>{n}</b>", { n: sets }) + (total > 0 ? " · " + L(lang, "Тоннаж: <b>{v} кг</b>", { v: fmt(total, lang) }) : ""),
    cmp ? L(lang, "Это как поднять: {v}", { v: L(lang, cmp[1]) }) : "",
    g ? L(lang, "По группам: {v}", { v: g }) : "",
    w.result ? L(lang, "Самочувствие: {v}", { v: esc(w.result) }) : "",
  ].filter(Boolean).join("\n");
}

// ---------------- LIGHT WEIGHT: новые рекорды ----------------
// постеры: img/lightweight/01.jpg … в папке приложения; добавили персонажа — увеличьте LW_COUNT
const LW_COUNT = 15;
async function findRecords(w: any) {
  const { data: others } = await admin.from("workouts").select("id,blocks").eq("participant_id", w.participant_id).neq("id", w.id);
  const prev: Record<string, number> = {};
  for (const o of others ?? []) for (const b of o.blocks ?? []) for (const e of b.exercises ?? []) for (const s of e.sets ?? [])
    if (Number(s.reps) >= 1) prev[e.exerciseId] = Math.max(prev[e.exerciseId] ?? 0, Number(s.weight) || 0);
  const out: { exerciseId: string; weight: number; reps: number }[] = [];
  for (const b of w.blocks ?? []) for (const e of b.exercises ?? []) {
    let best: { weight: number; reps: number } | null = null;
    for (const s of e.sets ?? []) {
      const wt = Number(s.weight) || 0, r = Number(s.reps) || 0;
      if (wt > 0 && r >= 1 && (!best || wt > best.weight || (wt === best.weight && r > best.reps))) best = { weight: wt, reps: r };
    }
    if (best && (prev[e.exerciseId] ?? 0) > 0 && best.weight > prev[e.exerciseId] && !out.some((x) => x.exerciseId === e.exerciseId))
      out.push({ exerciseId: e.exerciseId, ...best });
  }
  if (!out.length) return [];
  const { data: exs } = await admin.from("exercises").select("id,name").in("id", out.map((x) => x.exerciseId));
  return out.map((r) => ({ ...r, name: exs?.find((e: any) => e.id === r.exerciseId)?.name ?? "Упражнение" }));
}

// ---------------- «НУ ДАВАЙ, ЗАПЛАЧЬ!!!»: тренировка на 25%+ слабее обычного по группе мышц ----------------
// сравниваем тоннаж каждой группы мышц с её средним за прошлые тренировки (последние 120 дней, нужно ≥ 3 тренировок этой группы)
const WEAK_COUNT = 3;
function groupTonnage(w: any, info: Map<string, any>, bw: number) {
  const g: Record<string, number> = {};
  for (const b of w.blocks ?? []) for (const e of b.exercises ?? []) {
    const ex = info.get(e.exerciseId); if (!ex || ex.type === "cardio") continue;
    const own = ["strength", "functional"].includes(ex.type) ? bw : 0; let t = 0;
    for (const s of e.sets ?? []) {
      const wt = Number(s.weight) || 0; t += (wt > 0 ? wt : own) * (Number(s.reps) || 0);
      if (e.isDropset || s.isDrop) for (const d of s.drops ?? []) { const dw = Number(d.weight) || 0; t += (dw > 0 ? dw : own) * (Number(d.reps) || 0); }
    }
    if (t > 0) g[ex.main_group] = (g[ex.main_group] ?? 0) + t;
  }
  return g;
}
async function weakWorkout(w: any) {
  const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const { data: prev } = await admin.from("workouts").select("id,date,blocks,body_weight").eq("participant_id", w.participant_id)
    .neq("id", w.id).gte("date", since).lte("date", w.date);
  const all = [w, ...(prev ?? [])];
  const ids = new Set<string>(); all.forEach((x: any) => (x.blocks ?? []).forEach((b: any) => (b.exercises ?? []).forEach((e: any) => ids.add(e.exerciseId))));
  if (!ids.size) return null;
  const { data: exs } = await admin.from("exercises").select("id,main_group,type").in("id", [...ids]);
  const info = new Map((exs ?? []).map((e: any) => [e.id, e]));
  const { data: d } = await admin.from("profile_details").select("weight_kg").eq("user_id", w.participant_id).maybeSingle();
  const bwOf = (x: any) => Number(x.body_weight) || Number(w.body_weight) || Number(d?.weight_kg) || 0;
  const cur = groupTonnage(w, info, bwOf(w));
  const hist: Record<string, number[]> = {};
  for (const x of prev ?? []) for (const [k, v] of Object.entries(groupTonnage(x, info, bwOf(x)))) (hist[k] ??= []).push(v);
  const worse = Object.entries(cur).map(([k, v]) => { const h = hist[k] ?? []; if (h.length < 3) return null;
    const avg = h.reduce((a, b) => a + b, 0) / h.length; const drop = 1 - v / avg; return drop >= 0.25 ? { k, v, avg, drop } : null; })
    .filter(Boolean) as { k: string; v: number; avg: number; drop: number }[];
  return worse.length ? worse.sort((a, b) => b.drop - a.drop) : null;
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

  const { data: people } = await admin.from("profiles").select("*").in("id", [w.participant_id, ...(links ?? []).map((l: any) => l.trainer_id)]);
  const athlete = (people ?? []).find((x: any) => x.id === w.participant_id);
  const al = langOf(athlete);
  const text = await workoutSummary(w, al);
  // ачивки, полученные за эту тренировку (приложение присылает названия уже на языке пользователя)
  const achs = Array.isArray(body.achievements) ? body.achievements.filter((x: unknown) => typeof x === "string").slice(0, 30) : [];
  const achText = achs.length ? "\n\n" + L(al, "🏅 <b>Новые ачивки ({n}):</b>", { n: achs.length }) + "\n" + achs.map((a: string) => "• " + esc(a.slice(0, 80))).join("\n") : "";
  if (athlete?.telegram_id) await send(athlete.telegram_id, L(al, "✅ Тренировка завершена!") + "\n\n" + text + achText, appKb("📒 Открыть дневник", al));
  // ачивки серии «Light weight» (рекорды, герои, мировые рекорды): постер + за что дали
  const lwAch = Array.isArray(body.lw) ? body.lw.slice(0, 5) : [];
  if (athlete?.telegram_id && APP_URL) for (const a of lwAch) {
    const img = String(a?.img ?? "").replace(/^\/+/, "");
    if (!/^img\/lightweight\/[\w./-]+\.(jpg|webp)$/.test(img)) continue;
    await sendPhotoSafe(athlete.telegram_id, APP_URL + img, `🏆 <b>LIGHT WEIGHT — ${esc(String(a.title ?? "").slice(0, 80))}</b>\n\n${L(al, "За что:")} ${esc(String(a.desc ?? "").slice(0, 300))}`);
    await sleep(40);
  }
  // новый рекорд — постер «Light weight» с подписью
  const records = await findRecords(w);
  if (athlete?.telegram_id && records.length && APP_URL) {
    const n = String(1 + Math.floor(Math.random() * LW_COUNT)).padStart(2, "0");
    const caption = "🏆 LIGHT WEIGHT, BABY!\n\n" + records.map((r) =>
      L(al, "Впервые достигнут вес {kg} кг в упражнении «{ex}», количество повторений {reps}.", { kg: fmt(r.weight, al), ex: esc(exName(al, r.name)), reps: r.reps })).join("\n");
    await sendPhotoSafe(athlete.telegram_id, `${APP_URL}img/lightweight/${n}.jpg`, caption);
  }
  // слабая тренировка — постер «Ну давай, заплачь!!!» (не вместе с рекордом: рекорд важнее)
  if (athlete?.telegram_id && !records.length && APP_URL) {
    const weak = await weakWorkout(w).catch((e) => { console.log("WEAK_ERR", String(e)); return null; });
    if (weak) {
      const top = Math.round(weak[0].drop * 100);
      const caption = L(al, "😤 НУ ДАВАЙ, ЗАПЛАЧЬ!!!\n\nТренировка на {p}% хуже обычного:", { p: top }) + "\n" + weak.map((x) =>
        "• " + L(al, "{group}: {v} кг против обычных {avg} кг (−{p}%)", { group: L(al, MG[x.k] ?? x.k), v: fmt(x.v, al), avg: fmt(x.avg, al), p: Math.round(x.drop * 100) })).join("\n") + "\n\n" + L(al, "Следующая — злее. 💪");
      const n = String(1 + Math.floor(Math.random() * WEAK_COUNT)).padStart(2, "0");
      await sendPhotoSafe(athlete.telegram_id, `${APP_URL}img/weak/${n}.jpg`, caption);
    }
  }
  for (const t of (people ?? []).filter((x: any) => x.id !== w.participant_id && x.telegram_id)) {
    const tl = langOf(t);
    await send(t.telegram_id, L(tl, "👀 Подопечный <b>{name}</b> завершил тренировку:", { name: esc(athlete?.name) }) + "\n\n" + (tl === al ? text : await workoutSummary(w, tl)));
  }
  return json({ ok: true });
}

// ---------------- итоги недели / месяца / квартала / года ----------------
function addDays(ds: string, n: number) { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function periodsEndingToday(d: string) {
  const dt = new Date(d + "T12:00:00Z"), tomorrow = addDays(d, 1), out: { key: string; title: string; from: string; prevFrom: string; prevTo: string; y?: number; q?: number }[] = [];
  const y = +d.slice(0, 4), m = +d.slice(5, 7);
  if (tomorrow.slice(0, 4) !== d.slice(0, 4)) out.push({ key: "year", title: "Итоги {y} года", y, from: `${y}-01-01`, prevFrom: `${y - 1}-01-01`, prevTo: `${y - 1}-12-31` });
  if (tomorrow.slice(5, 7) !== d.slice(5, 7) && m % 3 === 0) { const q = m / 3, qs = `${y}-${String(m - 2).padStart(2, "0")}-01`;
    out.push({ key: "quarter", title: "Итоги {q}-го квартала", q, from: qs, prevFrom: new Date(Date.UTC(y, m - 6, 1)).toISOString().slice(0, 10), prevTo: addDays(qs, -1) }); }
  if (tomorrow.slice(5, 7) !== d.slice(5, 7)) { const ms = d.slice(0, 8) + "01";
    out.push({ key: "month", title: "Итоги месяца", from: ms, prevFrom: new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10), prevTo: addDays(ms, -1) }); }
  if (dt.getUTCDay() === 0) out.push({ key: "week", title: "Итоги недели", from: addDays(d, -6), prevFrom: addDays(d, -13), prevTo: addDays(d, -7) });
  return out;
}
async function periodStats(uid: string, from: string, to: string) {
  const { data: ws } = await admin.from("workouts").select("id,date,duration,blocks,body_weight,name").eq("participant_id", uid).gte("date", from).lte("date", to);
  const list = (ws ?? []).filter((w: any) => (w.blocks ?? []).some((b: any) => (b.exercises ?? []).some((e: any) => (e.sets ?? []).some((s: any) => Number(s.reps) > 0 || Number(s.time) > 0 || Number(s.distance) > 0))));
  const ids = new Set<string>(); list.forEach((w: any) => (w.blocks ?? []).forEach((b: any) => (b.exercises ?? []).forEach((e: any) => ids.add(e.exerciseId))));
  const { data: exs } = ids.size ? await admin.from("exercises").select("id,name,main_group,type").in("id", [...ids]) : { data: [] };
  const info = new Map((exs ?? []).map((e: any) => [e.id, e]));
  const { data: d } = await admin.from("profile_details").select("weight_kg").eq("user_id", uid).maybeSingle();
  let ton = 0, min = 0, km = 0, best: any = null; const groups: Record<string, number> = {};
  for (const w of list) {
    const g = groupTonnage(w, info, Number(w.body_weight) || Number(d?.weight_kg) || 0); const t = Object.values(g).reduce((a, b) => a + b, 0);
    ton += t; min += Number(w.duration) || 0; for (const [k, v] of Object.entries(g)) groups[k] = (groups[k] ?? 0) + v;
    if (!best || t > best.t) best = { t, date: w.date, name: w.name };
    for (const b of w.blocks ?? []) for (const e of b.exercises ?? []) for (const s of e.sets ?? []) km += info.get(e.exerciseId)?.type === "cardio" ? Number(s.distance) || 0 : 0;
  }
  return { n: list.length, ton, min, km, best, groups };
}
async function periodReports(p: any, d: string) {
  let sent = 0; const lang = langOf(p), kg = L(lang, "кг");
  for (const per of periodsEndingToday(d)) {
    const cur = await periodStats(p.id, per.from, d), prev = await periodStats(p.id, per.prevFrom, per.prevTo);
    if (!cur.n && !prev.n) continue;
    const diff = prev.ton > 0 ? Math.round((cur.ton / prev.ton - 1) * 100) : null;
    const top = Object.entries(cur.groups).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${L(lang, MG[k] ?? k)} ${fmt(v, lang)} ${kg}`).join(" · ");
    const text = [`📊 <b>${L(lang, per.title, { y: per.y, q: per.q })}</b> (${per.from.split("-").reverse().join(".")} — ${d.split("-").reverse().join(".")})`, "",
      L(lang, "Тренировок: <b>{n}</b>", { n: cur.n }) + (prev.n ? L(lang, " (было {n})", { n: prev.n }) : ""),
      L(lang, "Тоннаж: <b>{v} кг</b>", { v: fmt(cur.ton, lang) }) + (diff !== null ? L(lang, " ({d}% к прошлому периоду)", { d: (diff >= 0 ? "+" : "") + diff }) : ""),
      cur.min ? L(lang, "Время в зале: <b>{v} ч</b>", { v: Math.round(cur.min / 60 * 10) / 10 }) : "",
      cur.km ? L(lang, "Кардио: <b>{v} км</b>", { v: Math.round(cur.km * 10) / 10 }) : "",
      top ? L(lang, "Больше всего: {v}", { v: top }) : "",
      cur.best ? L(lang, "Лучшая тренировка: {name} {date} — {v} кг", { name: esc(cur.best.name ? L(lang, cur.best.name) : L(lang, "тренировка")), date: cur.best.date.split("-").reverse().join("."), v: fmt(cur.best.t, lang) }) : "",
      "", cur.n === 0 ? L(lang, "За период ни одной тренировки. Самое время вернуться 💪") : diff !== null && diff >= 0 ? L(lang, "Прогресс есть — так держать! 🔥") : L(lang, "Следующий период — сильнее. 💪")].filter((x, i, a) => x || (i > 0 && a[i - 1])).join("\n");
    await send(p.telegram_id, text, appKb("📊 Открыть статистику", lang)); sent++; await sleep(40);
  }
  return sent;
}

// ---------------- питание: норма (как в приложении) и отчёты ----------------
const KCAL_GOALS: Record<string, [string, number]> = { lose: ["снижение веса", 0.85], keep: ["поддержание веса", 1], gain: ["набор мышечной массы", 1.1] };
function ageFrom(b?: string) {
  if (!b) return 0; const d = new Date(b + "T12:00:00Z"), n = new Date();
  let a = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) a--;
  return a;
}
async function foodNormOf(uid: string) {
  const { data: d } = await admin.from("profile_details").select("*").eq("user_id", uid).maybeSingle();
  if (!d) return null;
  const w = +d.weight_kg || 0, h = +d.height_cm || 0, age = ageFrom(d.birth_date), act = +d.activity || 1.375;
  const goal = d.kcal_goal || (/похуд/i.test(d.goal || "") ? "lose" : /масс/i.test(d.goal || "") ? "gain" : "keep");
  const bmr = w && h && age && d.gender ? 10 * w + 6.25 * h - 5 * age + (d.gender === "male" ? 5 : -161) : 0;
  const kcal = +d.kcal_target || (bmr ? Math.round(bmr * act * KCAL_GOALS[goal][1] / 10) * 10 : 0);
  if (!kcal) return { kcal: 0, goal, p: 0 };
  return { kcal, goal, p: Math.round(w ? w * (goal === "keep" ? 1.6 : 2) : kcal * 0.25 / 4), f: Math.round(w ? w * 0.9 : kcal * 0.3 / 9) };
}
async function foodRows(uid: string, from: string, to: string) {
  const { data } = await admin.from("food_log").select("date,meal,kcal,protein,fat,carbs").eq("user_id", uid).gte("date", from).lte("date", to);
  return data ?? [];
}
const sum = (rows: any[], k: string) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
// итог дня: съедено / норма / БЖУ / по приёмам пищи + вывод
async function foodDaily(p: any, d: string) {
  const rows = await foodRows(p.id, d, d);
  if (!rows.length) return 0;
  const lang = langOf(p), n = await foodNormOf(p.id), kcal = sum(rows, "kcal"), pr = sum(rows, "protein"), g = L(lang, "г");
  const MEALS: [string, string[]][] = [["Завтрак", ["breakfast"]], ["Обед", ["lunch"]], ["Ужин", ["dinner"]], ["Перекусы", ["snack1", "snack2", "snack3"]]];
  const meals = MEALS.map(([t, ks]) => [t, sum(rows.filter((r: any) => ks.includes(r.meal)), "kcal")] as [string, number]).filter(([, v]) => v > 0)
    .map(([t, v]) => `${L(lang, t)} ${fmt(v, lang)}`).join(" · ");
  const lines = [L(lang, "🍽 <b>Питание за день</b> ({date})", { date: d.split("-").reverse().slice(0, 2).join(".") }), "",
    n?.kcal ? L(lang, "Съедено: <b>{v} ккал</b> из {norm} ({p}%)", { v: fmt(kcal, lang), norm: fmt(n.kcal, lang), p: Math.round(kcal / n.kcal * 100) }) : L(lang, "Съедено: <b>{v} ккал</b>", { v: fmt(kcal, lang) }),
    `${L(lang, "Белки")} ${fmt(pr, lang)}${n?.p ? "/" + n.p : ""} ${g} · ${L(lang, "Жиры")} ${fmt(sum(rows, "fat"), lang)}${n?.f ? "/" + n.f : ""} ${g} · ${L(lang, "Углеводы")} ${fmt(sum(rows, "carbs"), lang)} ${g}`,
    meals, ""];
  if (!n?.kcal) lines.push(L(lang, "Заполните возраст, пол, рост и вес в личных данных — я посчитаю вашу норму и подскажу, всё ли в порядке."));
  else {
    const r = kcal / n.kcal;
    lines.push(L(lang, "<b>Вывод:</b>") + " " + (r < 0.8 ? L(lang, "недобор {v} ккал — организму не хватает энергии на тренировки и восстановление. Если что-то съели и не записали — добавьте.", { v: fmt(n.kcal - kcal, lang) })
      : r > 1.1 ? L(lang, "перебор {v} ккал. Один такой день не страшен — завтра просто держитесь нормы.", { v: fmt(kcal - n.kcal, lang) })
      : L(lang, "калорийность в норме — отлично! ✅")));
    if (n.p && pr < n.p * 0.8) lines.push(L(lang, "Белка маловато: {v} из {t} г — добавьте мясо, рыбу, творог, яйца или протеин.", { v: fmt(pr, lang), t: n.p }));
  }
  await send(p.telegram_id, lines.filter((x, i, a) => x || (i > 0 && a[i - 1])).join("\n"), appKb("🍽 Открыть калории", lang));
  return 1;
}
// итоги питания за неделю / месяц / квартал / год: среднее за день, дни в норме, вес — и вывод
async function foodPeriodReports(p: any, d: string) {
  let sent = 0; const lang = langOf(p);
  for (const per of periodsEndingToday(d)) {
    const rows = await foodRows(p.id, per.from, d);
    const days = new Set(rows.map((r: any) => r.date));
    if (!days.size) continue;
    const n = await foodNormOf(p.id);
    const byDay: Record<string, number> = {}; rows.forEach((r: any) => byDay[r.date] = (byDay[r.date] ?? 0) + (Number(r.kcal) || 0));
    const avg = sum(rows, "kcal") / days.size, avgP = sum(rows, "protein") / days.size;
    const inNorm = n?.kcal ? Object.values(byDay).filter((v) => v >= n.kcal * 0.9 && v <= n.kcal * 1.1).length : 0;
    const prevRows = await foodRows(p.id, per.prevFrom, per.prevTo), prevDays = new Set(prevRows.map((r: any) => r.date)).size;
    const prevAvg = prevDays ? sum(prevRows, "kcal") / prevDays : 0;
    const { data: ws } = await admin.from("body_weights").select("date,weight_kg").eq("user_id", p.id).gte("date", per.from).lte("date", d).order("date", { ascending: true });
    const w0 = Number(ws?.[0]?.weight_kg) || 0, w1 = Number(ws?.[ws.length - 1]?.weight_kg) || 0, dw = ws && ws.length > 1 ? Math.round((w1 - w0) * 10) / 10 : null;
    const kg = L(lang, "кг");
    const lines = [`🍽 <b>${L(lang, per.title, { y: per.y, q: per.q })}: ${L(lang, "питание")}</b> (${per.from.split("-").reverse().join(".")} — ${d.split("-").reverse().join(".")})`, "",
      L(lang, "Дней с записями: <b>{n}</b>", { n: days.size }),
      L(lang, "В среднем за день: <b>{v} ккал</b>", { v: fmt(avg, lang) }) + (n?.kcal ? L(lang, " (норма {v})", { v: fmt(n.kcal, lang) }) : "") + (prevAvg ? L(lang, ", в прошлом периоде {v}", { v: fmt(prevAvg, lang) }) : ""),
      n?.kcal ? L(lang, "Дней в норме (±10%): <b>{n} из {t}</b>", { n: inNorm, t: days.size }) : "",
      L(lang, "Белок в среднем: {v} г/день", { v: fmt(avgP, lang) }) + (n?.p ? L(lang, " (цель {v} г)", { v: n.p }) : ""),
      dw !== null ? L(lang, "Вес: {a} → {b} {kg} ({d})", { a: w0, b: w1, kg, d: (dw > 0 ? "+" : "") + dw }) : "", ""];
    // вывод: калории + направление веса относительно цели
    let out: string;
    if (!n?.kcal) out = L(lang, "заполните личные данные — тогда я сравню питание с вашей нормой.");
    else {
      const r = avg / n.kcal, share = inNorm / days.size;
      out = share >= 0.7 ? L(lang, "отличная дисциплина — большинство дней в норме 🔥")
        : r > 1.1 ? L(lang, "в среднем перебор {v} ккал в день.", { v: fmt(avg - n.kcal, lang) })
        : r < 0.8 ? L(lang, "в среднем недобор {v} ккал в день — это мешает восстановлению и росту силы.", { v: fmt(n.kcal - avg, lang) })
        : L(lang, "почти в норме, но дни сильно скачут — старайтесь держаться ровнее.");
      if (dw !== null) {
        const ok = n.goal === "lose" ? dw < 0 : n.goal === "gain" ? dw > 0 : Math.abs(dw) <= 1;
        out += " " + (ok ? L(lang, "Вес меняется как нужно для вашей цели ({goal}) ✅", { goal: L(lang, KCAL_GOALS[n.goal][0]) })
          : L(lang, "Вес пока не идёт к цели ({goal}) — скорректируйте норму на 100–200 ккал.", { goal: L(lang, KCAL_GOALS[n.goal][0]) }));
      }
      if (n.p && avgP < n.p * 0.8) out += " " + L(lang, "Добавьте белка.");
    }
    lines.push(L(lang, "<b>Вывод:</b>") + " " + out);
    await send(p.telegram_id, lines.filter((x, i, a) => x || (i > 0 && a[i - 1])).join("\n"), appKb("🍽 Открыть калории", lang)); sent++; await sleep(40);
  }
  return sent;
}

// ---------------- расписание ----------------
async function recipients() {
  const { data } = await admin.from("profiles").select("*").not("telegram_id", "is", null).eq("reminders", true);
  return data ?? [];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// абонемент: за 4 дня и за 1 день до окончания (запускается вместе с утренней рассылкой)
async function membershipReminders() {
  let sent = 0;
  const in4 = today(4), in1 = today(1);
  const { data: list } = await admin.from("profile_details").select("user_id,membership_end").in("membership_end", [in4, in1]);
  for (const m of list ?? []) {
    const { data: p } = await admin.from("profiles").select("*").eq("id", m.user_id).maybeSingle();
    const lang = langOf(p);
    if (!p?.telegram_id) continue;
    const [y, mo, da] = m.membership_end.split("-");
    const text = m.membership_end === in1
      ? L(lang, "🎫 Завтра ({date}) последний день абонемента в зал. Не забудьте продлить!", { date: `${da}.${mo}` })
      : L(lang, "🎫 Абонемент в зал заканчивается через 4 дня — {date}. Самое время продлить 💪", { date: `${da}.${mo}.${y}` });
    await send(p.telegram_id, text, appKb("🎫 Обновить дату абонемента", lang));
    sent++; await sleep(40);
  }
  return sent;
}

// изменения в дневнике питания: всё от одного человека за 2 минуты — одним сообщением
async function foodNotifications(list: any[]) {
  let sent = 0;
  const MEAL: Record<string, string> = { breakfast: "завтрак", snack1: "перекус", lunch: "обед", snack2: "перекус", dinner: "ужин", snack3: "вечерний перекус" };
  const groups = new Map<string, any[]>();
  for (const n of list) { const k = `${n.user_id}|${n.payload?.from}|${n.payload?.by}`; groups.set(k, [...(groups.get(k) ?? []), n]); }
  for (const items of groups.values()) {
    const n0 = items[0];
    const { data: ps } = await admin.from("profiles").select("*").in("id", [n0.user_id, n0.payload?.from].filter(Boolean));
    const to = ps?.find((x: any) => x.id === n0.user_id), from = ps?.find((x: any) => x.id === n0.payload?.from);
    const lang = langOf(to);
    const who = `<b>${esc(from?.name ?? L(lang, "Участник"))}</b>`;
    const lines = items.map((n: any) => {
      const p = n.payload ?? {}, u = L(lang, p.unit === "ml" ? "мл" : "г"), when = `${L(lang, MEAL[p.meal] ?? "")}, ${String(p.date ?? "").split("-").reverse().slice(0, 2).join(".")}`;
      const verb = L(lang, p.action === "insert" ? "добавлено" : p.action === "delete" ? "удалено" : "изменено");
      const nm = (x: string) => esc(L(lang, x));   // продукты из базы переведены, свои — как записаны
      const what = p.action === "update" && (p.old_grams != p.grams || p.old_name !== p.name)
        ? `${nm(p.old_name ?? p.name)} ${Number(p.old_grams)} ${u} → ${nm(p.name)} ${Number(p.grams)} ${u}` : `${nm(p.name)} ${Number(p.grams)} ${u}`;
      return `• ${verb}: ${what} (${when})`;
    });
    const head = n0.payload?.by === "trainer"
      ? L(lang, "🍽 Тренер {who} изменил(а) ваш дневник питания:", { who })
      : L(lang, "🍽 {who} изменил(а) записи в своём дневнике питания, которые вносили вы:", { who });
    if (to?.telegram_id) { await send(to.telegram_id, `${head}\n${lines.join("\n")}`, appKb(undefined, lang)); sent++; await sleep(40); }
    await admin.from("notifications").update({ telegram_sent: true }).in("id", items.map((n: any) => n.id));
  }
  return sent;
}

async function cron(kind: string) {
  let sent = 0;
  if (kind === "notify") {
    const { data: list } = await admin.from("notifications").select("*").eq("telegram_sent", false).order("created_at").limit(200);
    sent += await foodNotifications((list ?? []).filter((n: any) => n.type === "food_changed"));
    for (const n of (list ?? []).filter((n: any) => n.type !== "food_changed")) {
      const ids = [n.user_id, n.payload?.from].filter(Boolean);
      const { data: ps } = await admin.from("profiles").select("*").in("id", ids);
      const to = ps?.find((x: any) => x.id === n.user_id), from = ps?.find((x: any) => x.id === n.payload?.from);
      const lang = langOf(to);
      const who = `<b>${esc(from?.name ?? L(lang, "Участник"))}</b>`, name = esc(n.payload?.name);
      const GOAL: Record<string, string> = { lose: "снижение веса", keep: "поддержание веса", gain: "набор мышечной массы" };
      const text: Record<string, string> = {
        friend_request: L(lang, "📨 {who} хочет добавить вас в участники. Ответьте в разделе «Участники».", { who }),
        friend_accepted: L(lang, "🤝 {who} подтвердил(а) заявку — теперь вы участники друг у друга.", { who }),
        trainer_offer: L(lang, "🏋️ {who} предлагает стать вашим тренером. Принять или отклонить можно в разделе «Участники».", { who }),
        trainer_assigned: L(lang, "✅ {who} принял(а) вас как тренера. Его (её) тренировки теперь в вашем календаре.", { who }),
        achievement_pending: L(lang, "🏅 Новый сертификат на проверке от {who}: «{name}». Откройте Настройки → Админ-панель.", { who, name }),
        achievement_approved: L(lang, "🏅 Ваш сертификат «{name}» подтверждён! Он уже в «Достижениях → Соревнования».", { name }),
        food_norm: L(lang, "🎯 Тренер {who} изменил(а) вашу норму питания: цель — <b>{goal}</b>, норма — <b>{target}</b>. Подробности в разделе «Калории».", { who,
          goal: L(lang, GOAL[n.payload?.goal] ?? "по расчёту"), target: n.payload?.target ? n.payload.target + " " + L(lang, "ккал") : L(lang, "по расчёту приложения") }),
        achievement_badge: L(lang, "🏅 За сертификат «{name}» вам выдана ачивка!", { name }),
        achievement_rejected: L(lang, "Сертификат «{name}» отклонён.", { name }) + (n.payload?.comment ? " " + L(lang, "Причина: {v}.", { v: esc(n.payload.comment) }) : "") + " " + L(lang, "Можно загрузить заново."),
      };
      // своя ачивка за сертификат (картинка из хранилища badges этого проекта) — присылаем картинкой
      const badgeImg = String(n.payload?.badge_img ?? ""), okImg = badgeImg.startsWith(`${SUPABASE_URL}/storage/v1/object/public/badges/`);
      if (to?.telegram_id && text[n.type] && okImg && ["achievement_approved", "achievement_badge"].includes(n.type)) {
        const cap = text[n.type] + `\n\n🏆 <b>${esc(String(n.payload?.badge_title ?? "").slice(0, 80))}</b>` + (n.payload?.badge_desc ? `\n${esc(String(n.payload.badge_desc).slice(0, 300))}` : "");
        await sendPhotoSafe(to.telegram_id, badgeImg, cap, appKb(undefined, lang)); sent++; await sleep(40);
      } else if (to?.telegram_id && text[n.type]) { await send(to.telegram_id, text[n.type], appKb(undefined, lang)); sent++; await sleep(40); }
      await admin.from("notifications").update({ telegram_sent: true }).eq("id", n.id);
    }
    return sent;
  }

  if (kind === "morning") sent += await membershipReminders(); // напоминания об абонементе — всем, даже с выключенными напоминаниями
  const users = await recipients();
  const d = today();
  for (const p of users) {
    const lang = langOf(p);
    try {
      if (kind === "evening") sent += await periodReports(p, d).catch((e) => { console.log("REPORT_ERR", String(e)); return 0; });
      if (kind === "evening") {
        sent += await foodDaily(p, d).catch((e) => { console.log("FOOD_DAY_ERR", String(e)); return 0; });
        sent += await foodPeriodReports(p, d).catch((e) => { console.log("FOOD_REPORT_ERR", String(e)); return 0; });
      }
      if (kind === "morning") {
        { const [n, t] = pick(MORNING_SET); await sendPhotoSafe(p.telegram_id, `${APP_URL}bot/morning/${n}.jpg`, L(lang, t)); }
        sent++;
      } else if (kind === "evening") {
        if (p.last_evening_date === d) continue;
        const [{ count: w }, { count: a }] = await Promise.all([
          admin.from("workouts").select("id", { count: "exact", head: true }).eq("participant_id", p.id).eq("date", d).eq("status", "done"),
          admin.from("daily_activity").select("id", { count: "exact", head: true }).eq("user_id", p.id).eq("date", d),
        ]);
        if ((w ?? 0) > 0 || (a ?? 0) > 0) continue;
        await admin.from("profiles").update({ last_evening_date: d, bot_state: { step: "activity_q", date: d } }).eq("id", p.id);
        await send(p.telegram_id, L(lang, "Сегодня тренировки не было. Была ли какая-то физическая активность за день?"), kb([[[L(lang, "👍 Да"), "act:yes"], [L(lang, "👎 Нет"), "act:no"]]]));
        sent++;
      } else if (kind === "motivation") {
        const border = today(-3); // тренировки не было больше 2 дней
        if (p.last_motivation_date && p.last_motivation_date > today(-3)) continue;
        if (p.created_at.slice(0, 10) > border) continue;
        const { data: last } = await admin.from("workouts").select("date").eq("participant_id", p.id).eq("status", "done").lte("date", d).order("date", { ascending: false }).limit(1);
        if (last?.[0] && last[0].date > border) continue;
        await admin.from("profiles").update({ last_motivation_date: d }).eq("id", p.id);
        await send(p.telegram_id, L(lang, pick(MOTIVATION)), appKb("📅 Запланировать тренировку", lang));
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
