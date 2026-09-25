// supabase/functions/telegram-auth/index.ts
//
// Что делает: принимает initData из Telegram Mini App, проверяет её подлинность
// (что данные действительно от Telegram, а не подделаны), создаёт/находит профиль
// пользователя и выдаёт код, с которым фронтенд получает настоящую сессию Supabase.
//
// Секреты, которые нужно задать в Supabase (Project Settings → Edge Functions → Secrets,
// или командой `supabase secrets set`):
//   TELEGRAM_BOT_TOKEN      — токен от BotFather
//   SUPABASE_URL            — подставляется автоматически Supabase, вручную не нужно
//   SUPABASE_SERVICE_ROLE_KEY — подставляется автоматически Supabase, вручную не нужно

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_AUTH_AGE_SECONDS = 86400; // initData считается свежей не дольше суток

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function hmacRaw(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Официальный алгоритм проверки Telegram WebApp initData:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
async function verifyInitData(initData: string, botToken: string) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const pairs: string[] = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = await hmacRaw(new TextEncoder().encode("WebAppData"), botToken);
  const computed = toHex(await hmacRaw(secretKey, dataCheckString));
  if (computed !== hash) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_AGE_SECONDS) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;
  return JSON.parse(userRaw) as { id: number; first_name?: string; last_name?: string; username?: string };
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { initData } = await req.json();
    if (!initData) {
      return new Response(JSON.stringify({ error: "initData отсутствует" }), { status: 400, headers: corsHeaders });
    }

    const tgUser = await verifyInitData(initData, BOT_TOKEN);
    if (!tgUser) {
      return new Response(JSON.stringify({ error: "Подпись Telegram не прошла проверку" }), { status: 401, headers: corsHeaders });
    }

    const syntheticEmail = `tg${tgUser.id}@telegram.trendnevnik.local`;
    const displayName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") || "Без имени";

    // Ищем пользователя по telegram_id в profiles (это наш источник правды,
    // так как auth.admin.listUsers не умеет фильтровать по метаданным надёжно)
    const { data: existing, error: profileLookupError } = await admin
      .from("profiles")
      .select("id")
      .eq("telegram_id", tgUser.id)
      .maybeSingle();

    console.log(
      "PROFILE_LOOKUP_ERROR:",
      profileLookupError ? JSON.stringify(profileLookupError) : "none"
    );

    let userId: string;

    if (existing) {
      userId = existing.id;
    } else {
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: syntheticEmail,
        email_confirm: true,
        user_metadata: { telegram_id: tgUser.id, telegram_username: tgUser.username },
      });
      if (createErr || !created.user) {
        return new Response(JSON.stringify({ error: "Не удалось создать пользователя: " + createErr?.message }), { status: 500, headers: corsHeaders });
      }
      userId = created.user.id;

      const { error: profileErr } = await admin.from("profiles").insert({
        id: userId,
        telegram_id: tgUser.id,
        telegram_username: tgUser.username ?? null,
        name: displayName,
      });
      if (profileErr) {
        return new Response(JSON.stringify({ error: "Не удалось создать профиль: " + profileErr.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Обновляем имя/username на случай, если человек их поменял в Telegram
    await admin.from("profiles").update({
      telegram_username: tgUser.username ?? null,
      name: displayName,
    }).eq("id", userId);

    // Выпускаем одноразовый код для входа (magic link OTP), которым фронтенд
    // на следующем шаге обменяется на настоящую сессию через supabase.auth.verifyOtp
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: syntheticEmail,
    });
    if (linkErr || !linkData) {
      return new Response(JSON.stringify({ error: "Не удалось выпустить код входа: " + linkErr?.message }), { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({
      email: syntheticEmail,
      otp: linkData.properties.email_otp,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
