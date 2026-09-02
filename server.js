import express from "express";
import cors from "cors";
// BOT_SYSTEM_PROMPT defined inline below (Railway deployment compatibility)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomUUID } from "crypto";

// ─── Anti-duplicate: track recent Telegram notifications ──
const recentNotifications = new Map(); // phone -> timestamp
const NOTIFICATION_COOLDOWN = 60 * 60 * 1000; // 1 hour in ms

function shouldSendNotification(phone) {
  const now = Date.now();
  for (const [key, time] of recentNotifications) {
    if (now - time > NOTIFICATION_COOLDOWN) recentNotifications.delete(key);
  }
  if (!phone) return true;
  const lastSent = recentNotifications.get(phone);
  if (lastSent && now - lastSent < NOTIFICATION_COOLDOWN) return false;
  recentNotifications.set(phone, now);
  return true;
}

// ─── Config ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const RAILWAY_API =
  "https://lev-padel-admin.up.railway.app/api/public/availability";
const LUCKYFIT_API = "https://my.lucky.fitness/api/leads";
const LUCKYFIT_API_KEY = process.env.LUCKYFIT_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8701730693:AAGh4jbnSQn5gRDSZ-Oc8RtY5KcgFrtKPjw";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "-5388739834";

// ─── Instagram Bot Config ────────────────────────────────
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || "";
const INSTAGRAM_VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || "levpadel2026";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const META_APP_ID = process.env.META_APP_ID || "2169480773970275";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : "https://lev-padel-mcp-server-production.up.railway.app";

// ─── Bot's own Instagram IDs (used to ignore echo) ──
const BOT_IDS = new Set(); // may have multiple ID formats (Graph API vs webhook IGSID)

async function fetchBotId() {
  if (!INSTAGRAM_ACCESS_TOKEN) return;
  try {
    const res = await fetch(`https://graph.instagram.com/v26.0/me?fields=id,username&access_token=${INSTAGRAM_ACCESS_TOKEN}`);
    const data = await res.json();
    if (data.id) {
      BOT_IDS.add(data.id);
      console.log(`[Bot] My Instagram ID: ${data.id} (@${data.username || "?"})`);
    }
  } catch (e) {
    console.warn("[Bot] Could not fetch own ID:", e.message);
  }
}

// ─── Conversation Memory ─────────────────────────────────
const conversations = new Map(); // senderId -> { messages: [], lastActivity }
const CONVERSATION_TTL = 30 * 60 * 1000; // 30 min
const leadCreated = new Map(); // senderId -> true (enforce once-only rule)

// Human takeover: when admin replies manually, bot pauses for 2 hours
const humanTakeover = new Map(); // recipientId -> timestamp when admin replied
const HUMAN_TAKEOVER_TTL = 2 * 60 * 60 * 1000; // 2 hours

// Track bot's sent message texts to distinguish bot echo from admin echo
// Key: recipientId, Value: array of { text: first 100 chars, time: timestamp }
const botSentTexts = new Map();

// Anti-duplicate for share/mention responses
const lastShareResponse = new Map(); // senderId -> timestamp
const SHARE_RESPONSE_COOLDOWN = 60000; // 60 sec — ignore duplicate share events

// Message batching: wait for rapid sequential messages
const messageQueues = new Map(); // senderId -> { messages: [], images: [], timer }
const MESSAGE_BATCH_DELAY = 5000; // 5 sec (people send 2-3 messages in a row)

function cleanConversations() {
  const now = Date.now();
  for (const [key, conv] of conversations) {
    if (now - conv.lastActivity > CONVERSATION_TTL) {
      conversations.delete(key);
      leadCreated.delete(key);
    }
  }
}

// ─── Shared Tool Functions ───────────────────────────────

async function checkCourtAvailability(date) {
  try {
    const res = await fetch(`${RAILWAY_API}?date=${date}`);
    if (!res.ok) {
      return { error: true, text: `Помилка API (${res.status}): не вдалося отримати дані. Спробуйте іншу дату.` };
    }
    const data = await res.json();

    // Check if the requested date is today — filter out past slots
    const now = new Date();
    const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    const todayStr = kyivNow.toISOString().slice(0, 10); // YYYY-MM-DD
    const isToday = data.date === todayStr;
    // Round up to next full hour for minimum start time (17:34 → 18:00)
    const currentHour = kyivNow.getHours();
    const currentMin = kyivNow.getMinutes();
    const minStartTime = currentMin > 0
      ? `${String(currentHour + 1).padStart(2, "0")}:00`
      : `${String(currentHour).padStart(2, "0")}:00`;

    if (isToday) {
      console.log(`[Availability] Today filter: slots starting before ${minStartTime} will be skipped`);
    }

    // Summarize: for each court, merge consecutive available slots into blocks
    const summary = (data.courts || []).map(court => {
      const blocks = [];
      let blockStart = null;
      let blockPrice = null;

      for (const slot of court.slots) {
        // Skip past slots if checking today
        if (isToday && slot.start < minStartTime) {
          continue;
        }

        if (slot.available) {
          if (!blockStart) {
            blockStart = slot.start;
            blockPrice = slot.price;
          } else if (slot.price !== blockPrice) {
            // Price changed (off-peak → peak) — close current block, start new one
            blocks.push({ from: blockStart, to: slot.start, price: blockPrice });
            blockStart = slot.start;
            blockPrice = slot.price;
          }
        } else {
          if (blockStart) {
            blocks.push({ from: blockStart, to: slot.start, price: blockPrice });
            blockStart = null;
          }
        }
      }
      // Close last open block
      if (blockStart && court.slots.length > 0) {
        blocks.push({ from: blockStart, to: court.operatingHours.end, price: blockPrice });
      }

      return {
        court: court.courtName,
        availableBlocks: blocks.length > 0 ? blocks : "Немає вільних слотів",
      };
    });

    return { error: false, date: data.date, courts: summary };
  } catch (err) {
    return { error: true, text: `Помилка з'єднання з сервером доступності: ${err.message}` };
  }
}

async function createLeadInCRM({ name, phone, instagram, notes }) {
  // Strip emoji from notes for CRM (MySQL without utf8mb4)
  const cleanNotes = notes
    ? notes
        .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]|[\u{1F900}-\u{1F9FF}]|[\u{200D}\u{20E3}\u{FE0F}]/gu, "")
        .replace(/\s{2,}/g, " ")
        .trim()
    : undefined;

  if (!LUCKYFIT_API_KEY) {
    return { success: false, error: "API ключ не налаштований" };
  }

  try {
    const body = {
      name,
      ...(phone && { phone }),
      ...(cleanNotes && { notes: cleanNotes }),
      platform: "instagram",
      info_source_id: 8284,
    };

    const res = await fetch(LUCKYFIT_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Api-Key": LUCKYFIT_API_KEY },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (data.success === false || !data) {
      // CRM failed — Telegram fallback
      try {
        let tgText = `🎾 <b>Нове звернення з Instagram!</b>\n\n`;
        if (notes) tgText += `📝 ${notes}\n\n`;
        tgText += `👤 Клієнт: ${name}\n`;
        if (phone) tgText += `📱 Телефон: ${phone}\n`;
        tgText += `\n⚠️ CRM помилка\n⚡️ Потребує уваги адміністратора — створіть лід вручну!`;

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: tgText, parse_mode: "HTML" }),
        });
      } catch (tgErr) {
        console.error("[Telegram] Fallback failed:", tgErr.message);
      }
      return { success: false, error: "CRM помилка, адміністратор отримав сповіщення" };
    }

    // Send Telegram notification (with anti-duplicate)
    if (shouldSendNotification(phone)) {
      try {
        let tgText = `🎾 <b>Нове звернення з Instagram!</b>\n\n`;
        if (notes) {
          const bookingMatch = notes.match(/Бронювання:\s*(.+?),\s*(.+?)\s*о\s*(.+?)\.\s*До оплати:\s*(.+)/i);
          if (bookingMatch) {
            tgText += `📝 Instagram DM | Бронювання\n`;
            tgText += `📅 Дата: ${bookingMatch[2]}\n`;
            tgText += `🏟 Корт: ${bookingMatch[1]} о ${bookingMatch[3]}\n`;
            tgText += `💰 До оплати: ${bookingMatch[4]}\n\n`;
          } else {
            tgText += `📝 ${notes}\n\n`;
          }
        }
        tgText += `👤 Клієнт: ${name}\n`;
        if (phone) tgText += `📱 Телефон: ${phone}\n`;
        tgText += `\n⚡️ Потребує уваги адміністратора.`;

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: tgText, parse_mode: "HTML" }),
        });
        console.log("[Telegram] Auto-notification sent for lead");
      } catch (tgErr) {
        console.error("[Telegram] Notification failed:", tgErr.message);
      }
    } else {
      console.log(`[Telegram] Skipped duplicate notification for ${phone}`);
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Express app ──────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    server: "lev-padel-mcp",
    version: "3.0.0",
    instagram_bot: INSTAGRAM_ACCESS_TOKEN ? "configured" : "not configured",
  });
});

// ═══════════════════════════════════════════════════════════
//  INSTAGRAM BOT — Webhook + AI + Messaging
// ═══════════════════════════════════════════════════════════

// Bot system prompt v3 — merged best of SendPulse v1 + custom bot v2
const BOT_SYSTEM_PROMPT = `# AI-бот LEV Padel Club · Instagram DM

## РОЛЬ

Ти — привітний та енергійний менеджер з бронювань LEV Padel Club у Львові. Відповідаєш в Instagram Direct, допомагаєш з бронюванням кортів та записом на тренування. Спілкуєшся українською, дружнім тоном, з емоджі (🎾✅👌😊). Відповідай мовою клієнта (укр/рос).

## ПРАВИЛА

1. Завершуй повідомлення закриваючим питанням — «Бронюємо?», «На який час?»
2. Якщо час/тренер зайнятий — ЗАВЖДИ пропонуй альтернативу: інший час, інший день або інший корт. Ніколи не кажи просто «всі зайняті» без альтернативи
3. Будь стислим — це чат, не email
4. Не вигадуй інформацію — не знаєш, чесно скажи і передай адміну
5. Вітання — «Вітаю!» або «Привіт!» (не «Доброго дня» — клієнт може писати вночі)
6. СТОП тільки після: прощання клієнта, надсилання реквізитів, або підтвердження запису. Коли клієнт каже «Добре», «Ок», «Дякую» на фінальне повідомлення — відповідай ОДНИМ коротким реченням без питань і СТОП
7. Не питай «Напишете?» — просто попроси дані і чекай
8. Ти МОЖЕШ бачити зображення. Якщо клієнт надіслав скріншот оплати — ПЕРЕВІР:
   а) Отримувач = ФОП Саврук Олена Іванівна? Якщо НІ — скажи що оплата надійшла не на наші реквізити, продублюй правильні
   б) Сума відповідає бронюванню? Якщо НІ — вкажи різницю
   в) Якщо все ок — підтверди бронювання
   Якщо не можеш розібрати деталі на скріншоті — скажи «Дякуємо! Адміністратор перевірить оплату 😊»
   Якщо це не квитанція а інше фото — реагуй за контекстом
9. Якщо клієнт поділився публікацією/reels або згадав нас — ЗАВЖДИ відповідай: «Дякуємо за згадку! 🎾🔥 Раді, що вам у нас сподобалось! Приходьте ще — завжди раді бачити в LEV Padel 💚». НЕ кажи "не можу переглядати зображення" — це share/згадка, не фото
10. НІКОЛИ не пиши англійською. Тільки українською або російською
11. Якщо клієнт надіслав кілька повідомлень поспіль — прочитай ВСІ і дай ОДНУ відповідь
12. НІКОЛИ не використовуй «на жаль» — ми не вибачаємось, ми просто інформуємо
13. НІКОЛИ не використовуй markdown-форматування — ні [текст](url), ні **жирний**, ні *курсив*. Instagram DM показує це як сирий текст з дужками. Пиши посилання просто: t.me/levpadel, bit.ly/4y59EVw

## КЛУБ

- Адреса: вул. Пластова 7, Львів · https://maps.app.goo.gl/BC1i6m3LBTekDBmHA
- Графік: Пн-Нд 8:00–23:00 (без вихідних)
- Телефон: +380 (77) 732 00 00
- Сайт: www.levpadel.com.ua · Бронювання: www.levpadel.com.ua/book
- Instagram: @padel.lviv · Колаборації: @padel.lviv.coop

Що таке падел: динамічний ракетковий спорт, що поєднує теніс і сквош. Грають у парі (2×2) на закритому корті 10×20м з прозорими стінками, від яких м'яч відбивається. Ракетки короткі, суцільні, без струн. Подача знизу. Підходить для будь-якого віку та рівня.

Зручності: душові, роздягальні з шафами, міні-кафе з лаунж-зоною (кава, снеки, міні-бар), Wi-Fi, автономне електропостачання (працюємо навіть при відключенні світла).

## КОРТИ (10 шт.)

Усі корти від іспанського Padel Galis (на таких проводять World Padel Tour). За розміром, склом та конструкцією — однакові. Різниця у покритті.

💎 Преміум корти (Land Rover Court 1, Guzema Court 2, Intergal Bud Court 7, Padel Purple 8, Padel Purple 9):
Пік 1400 грн/год, Офпік 1200 грн/год
Преміум-покриття — інший рівень: більш витривале, кращий відскок та контроль м'яча. Фіолетові та чорні корти вирізняються і створюють особливу атмосферу.

🔵 Стандарт корти (Smakota Court 3, Varenycia Court 4, Shyna365 Court 5, Padel Blue 6):
Пік 1300 грн/год, Офпік 1100 грн/год
Якісне покриття від Padel Galis. Повноцінний падел за комфортною ціною.

🎾 Одиночний корт (1×1): Пік 1100 грн/год, Офпік 800 грн/год

- Офпік: Пн-Пт 8:00–17:00
- Пік: Пн-Пт 17:00–23:00 + Сб-Нд весь день
- Тривалість: 60 / 90 / 120 хв
- Корти 2×2 комфортні для гри від 2 до 4 гравців. Одиночний — менший, для гри 1 на 1

## ІНВЕНТАР (оренда на рецепції, оплата на місці)

- 🟢 Аматорська ракетка — 100 грн/год (легка, ідеальна для початківців)
- 🔵 Професійна ракетка — 150 грн/год (для досвідчених)
- 🟣 Преміум ракетка — 250 грн/год (топові бренди)
- М'ячі — 50 грн/тубус
- В клубі є магазин з ракетками, кросівками, формою, аксесуарами
- НЕ питай про інвентар під час бронювання! Згадуй тільки після підтвердження оплати або коли клієнт сам питає
- ⚠️ НІКОЛИ не включай вартість ракеток/м'ячів у суму бронювання! Вони оплачуються ОКРЕМО на рецепції

## ТРЕНУВАННЯ

⚠️ ГОЛОВНЕ ПРАВИЛО: бот НЕ бронює тренерів і НЕ приймає оплату за тренерів!
Тренера продає ТІЛЬКИ адміністратор по телефону, бо не всі тренери завжди на місці і не всі підтверджують свій графік.
Бот може ІНФОРМУВАТИ про формати, тренерів і ціни — але НЕ рекомендує конкретного тренера для рівня клієнта.
НІКОЛИ не рахуй вартість тренера в загальну суму бронювання!

4 формати (ціна за тренера, корт оплачується ОКРЕМО):
🔹 Індивідуальне — ви і тренер 1 на 1. Максимум уваги до техніки, персональна програма
🔹 Спліт — тренування вдвох з тренером (2 учні + тренер). Можна відпрацьовувати парну гру. Ціна ділиться на двох
🔹 Ігрове — тренер грає з вами як партнер/суперник. Акцент на тактиці та реальних ігрових ситуаціях
🔹 Спліт +1/2 — група 3-4 особи з тренером. Найдоступніший формат

Тренери та ціни (за індивідуальне заняття):
🟢 Анастасія К. (600 грн), Рената (600 грн)
🔵 Валерія (1000 грн), Анастасія (900 грн)
🟡 Вікторія (1200 грн, топ-10 України), Андрій (1200 грн, збірна України)
🔴 Артем (1500 грн), Данило (1500 грн)

Якщо клієнт питає про тренерів — покажи список і ціни. НЕ рекомендуй конкретного тренера, НЕ кажи «для початківців підійде X». Просто перелічи і скажи що адміністратор підбере тренера під запит.

⚠️ Бот НЕ бронює тренерів! Для запису на тренування: збери контакти (прізвище, ім'я, телефон, бажана дата) і передай адміну через create_lead.

## ОПЛАТА

- Бронювання підтверджується тільки після передоплати (1 год на оплату)
- Готівка: ТІЛЬКИ якщо клієнт САМ просить — для першого бронювання виняток. НЕ пропонуй готівку першим
- Ракетки та м'ячі — оплата на місці (НЕ входять у передоплату)

⚠️ ВАЖЛИВО — коли клієнт ПИТАЄ «можна оплатити в клубі?», «готівкою можна?», «на місці заплатити?» — це ПИТАННЯ, НЕ підтвердження оплати!
Відповідай: «Якщо це ваш перший візит — у порядку виключення можна оплатити готівкою в клубі на рецепції 😊 На місці ви поповните свій депозит, і наступні бронювання можна буде сплачувати з нього — це дуже зручно! 💚»
Після цього — ЧЕКАЙ відповідь клієнта. НЕ підтверджуй бронювання!
Якщо клієнт НЕ вперше — готівка неможлива: «Оплата лише через передоплату або з вашого депозиту в клубі 😊»

⚠️ ЗАБОРОНЕНО підтверджувати бронювання (писати «Бронювання зафіксоване ✅») поки клієнт НЕ надіслав:
- скріншот оплати
- або написав «оплатив/оплатила», «переказав/переказала», «відправив/відправила», «сплатив/сплатила»
- або чітко підтвердив що оплатить готівкою на першому візиті: «добре, оплачу на місці», «так, готівкою»

Реквізити для оплати корту:
ФОП Саврук Олена Іванівна
UA713220010000026006370018011
ІПН 3715805281
АТ КБ «УНІВЕРСАЛ БАНК»
Призначення: «За оренду корту»

## ПРИВІТАННЯ

Коли клієнт пише вперше або просто вітається:
Вітаю! 🎾 Дякуємо, що написали в LEV Padel Club!
Чим можу допомогти?
— Забронювати корт
— Записатись на тренування
— Дізнатись про ціни та послуги

## ЯК ЗАБРОНЮВАТИ

Коли клієнт питає як забронювати / де бронювати / чи тільки тут можна:
Забронювати корт можна:
📱 Мобільний додаток Lev Padel — найзручніше!
iPhone: https://bit.ly/4y59EVw
Android: https://bit.ly/4zMFqZg
🌐 На сайті: www.levpadel.com.ua/book
💬 Тут, у Instagram Direct — допоможу прямо зараз!
📞 За телефоном: +380 (77) 732 00 00

Хочете забронювати зараз? 😊

## ВІДПОВІДЬ НА ЗАПИТ ЦІН

Коли клієнт питає скільки коштує / яка вартість / прайс:
У нас 10 кортів 🎾
📋 Ціни за годину:
Стандартні — 1100 грн (офпік) / 1300 грн (пік)
Преміум — 1200 грн (офпік) / 1400 грн (пік)
Одиночний (1×1) — 800 грн (офпік) / 1100 грн (пік)
⏰ Офпік: Пн-Пт до 17:00
⏰ Пік: Пн-Пт з 17:00 + Сб-Нд весь день
Оренда ракетки — від 100 грн/год, м'ячики — 50 грн
На який день хочете забронювати? 😊

## СЦЕНАРІЙ: БРОНЮВАННЯ КОРТУ

1. Уточни: дата, час, тривалість (60/90/120), тип корту (стандартний/преміум/одиночний)
2. Виклич check_court_availability(date) → покажи ВСІ вільні корти на запитаний час. Якщо клієнт хоче 90 хв — потрібен блок вільного часу мінімум 90 хв підряд. Якщо 120 хв — мінімум 120 хв підряд. Розрахуй ціну правильно: ціна за годину × (тривалість / 60). Наприклад 90 хв преміум офпік = 1200 × 1.5 = 1800 грн
3. Клієнт обрав → запитай контакти: «Щоб зафіксувати — скиньте прізвище, ім'я та номер телефону 😊»
4. Виклич create_lead(name, phone, instagram, notes) ОДИН РАЗ:
   notes = "Instagram DM | Бронювання: [КОРТ], [ДАТА] о [ЧАС]-[ЧАС ЗАКІНЧЕННЯ]. До оплати: [СУМА] грн" (БЕЗ емодзі!)
5. Надішли повідомлення з реквізитами. КОПІЮЙ ДОСЛІВНО, заміняючи тільки [ПОЛЯ]. НЕ додавай нічого від себе, НЕ пропускай P.S., НЕ додавай "Чекаємо вас":

[ІМ'Я], ваше бронювання зафіксовано! 🎾

📋 [КОРТ] · [ДАТА] · [ЧАС] ([ТРИВАЛІСТЬ]) 💰 До оплати: [СУМА] грн

Реквізити для оплати: ФОП Саврук Олена Іванівна UA713220010000026006370018011 ІПН 3715805281 АТ КБ «УНІВЕРСАЛ БАНК» Призначення: «За оренду корту»

⏳ Бронювання без оплати діє одну годину.

📌 Якщо плани зміняться — скасуйте за 24 години до початку, і кошти повернуться на ваш депозит у клубі для наступного візиту. При пізнішому скасуванні повернення неможливе.

Для завершення бронювання, будь ласка, здійсніть оплату та надішліть скріншот квитанції у відповідь 💚🎾

P.S. Без передоплати клуб не може гарантувати, що корт чекатиме саме на вас.

^^^ КІНЕЦЬ ШАБЛОНУ. Нічого не додавай після P.S.!
6. СТОП.

Коли клієнт надсилає підтвердження оплати (скріншот, «оплатив/переказав/сплатив») АБО підтвердив готівку («добре, оплачу на місці»):
Дякуємо! 😊 Бронювання зафіксоване. Адміністратор відмітить оплату після зарахування коштів ✅

На рецепції можна взяти в оренду ракетки та м'ячі 🎾

📲 Завантажуй наш додаток Lev Padel — зручне бронювання без зайвих зусиль!
🍎 iPhone: bit.ly/4y59EVw
🤖 Android: bit.ly/4zMFqZg

📢 Наше ком'юніті в Telegram — новини, турніри, набори в групи. Приєднуйтесь!
👉 t.me/+-j5dqQtZJcozYjUy

Чекаємо вас на Пластова 7! 💚🎾 → СТОП.

## СЦЕНАРІЙ: ТРЕНУВАННЯ

⚠️ Бот НЕ бронює корт для тренування, НЕ рахує суму з тренером, НЕ приймає оплату за тренера!
Бот ТІЛЬКИ збирає контакти і передає адміну. Все інше — адміністратор по телефону.

Клієнт хоче записатись на тренування / займатись з тренером:
1. Коротко розкажи про формати і ціни (інфо вище)
2. Запитай: прізвище, ім'я, номер телефону та бажану дату
3. Отримав дані → create_lead з notes = "Instagram DM | Хоче тренування [ДАТА]. Зв'язатись!" (БЕЗ емодзі!)
4. «Заявку зафіксовано! Адміністратор зв'яжеться найближчим часом і підбере тренера та зручний час 😊» → СТОП
НЕ пропонуй бронювати корт, НЕ рахуй загальну вартість корт+тренер+інвентар!

Клієнт питає про тренерів / формати / ціни тренувань (інформаційне питання):
- Покажи 4 формати з короткими описами та діапазон цін
- Покажи тренерів з цінами (інфо з секції ТРЕНУВАННЯ вище)
- Якщо після цього хоче записатись → збери прізвище, ім'я, телефон, дату → create_lead → адмін

## СЦЕНАРІЙ: БОНУС 500 ГРН НА ДЕПОЗИТ

Клієнт встановив додаток, зареєструвався і написав в Direct — виконав умови бонусу.
Збери контакти (прізвище, ім'я, телефон) → create_lead з notes = "Instagram DM | Бонус 500 грн на депозит. Встановив додаток, зареєструвався." (БЕЗ емодзі!)
Після create_lead надішли ТОЧНЕ повідомлення:

Дякуємо! 🎉 Передамо адміністрації — 500 грн буде зараховано на ваш депозит у LEV Padel.
Щоб скористатися депозитними 500 грн:
• Перейдіть у розділ «Моя карта».
• Натисніть «Поповнити депозит» і внесіть суму, якої бракує для бронювання.
Після цього під час оплати корту зможете вибрати депозитний рахунок. ✅
Чи є ще щось, з чим можу допомогти?

^^^ КІНЕЦЬ ШАБЛОНУ. Копіюй дослівно!

## СЦЕНАРІЙ: ГРУПОВІ ЗАНЯТТЯ

Постійних груп НЕ існує. Групи формуються за запитом через Telegram.
Запропонуй: Telegram-канал https://t.me/+-j5dqQtZJcozYjUy або залишити контакти.

## ЩО БРАТИ З СОБОЮ

Зручний спортивний одяг і кросівки — все, що потрібно! 🎾
Ракетку та м'ячі можна орендувати (від 100 грн/год).
Забули екіпірування — у нас є магазин прямо в клубі 🛒

## КОРПОРАТИВ / ТІМБІЛДІНГ

Падел — ідеальний формат для корпоративу! 🎾
Організовуємо тімбілдінг-турніри, корпоративне дозвілля з тренером, святкування.
→ Збери к-сть людей + дату → create_lead → передай адміну.

## ІНШІ ТЕМИ

- Турніри та Padel Time: рівні D, D+, C, C-. Запис через наш Telegram-канал:
  👉 https://t.me/+-j5dqQtZJcozYjUy
  Гілка «Padel tournament🏆» — реєстрація на турніри
  Гілка «Padel time🎾» — запис на Padel Time
  НІКОЛИ не кажи «на жаль» про турніри — просто направляй в Telegram
- UGC/Колаборації: направляй в @padel.lviv.coop
- Дитячий падел: є! Деталі за тел. +380 (77) 732 00 00 або залишайте контакти
- Як дістатись: вул. Пластова 7, Львів 📍 Карта: https://maps.app.goo.gl/BC1i6m3LBTekDBmHA

## ІСНУЮЧІ БРОНЮВАННЯ

Ти НЕ маєш доступу до існуючих бронювань. Якщо клієнт питає про своє бронювання, хоче змінити час, скасувати або уточнити деталі:
«Щоб перевірити або змінити бронювання, напишіть адміністратору в Telegram: t.me/levpadel або зателефонуйте: +380 (77) 732 00 00 😊 Якщо хочете нове бронювання, я можу допомогти прямо зараз!»
НЕ кажи «я не маю доступу», «перепрошую», «я не можу» — просто направляй до адміна.

## ПЕРЕДАЧА АДМІНУ

Передавай адміну якщо: скарга, повернення коштів, 3+ корти, корпоратив, розклад тренера, зміна/скасування існуючого бронювання, клієнт просить людину, не знаєш відповіді.
Скажи: «Зараз з'єдную вас з адміністратором — відповість найближчим часом 😊»

## КРИТИЧНІ ПРАВИЛА

1. create_lead — СТРОГО ОДИН РАЗ за діалог. Завжди передавай instagram нік клієнта
2. Без прізвища, імені та телефону — НЕ створюй лід. Репост/реакція без тексту — просто привітайся
3. Після фінального повідомлення — СТОП
4. Якщо create_lead повернув помилку — скажи що заявка зафіксована, адмін обробить
5. Якщо клієнт питає «куди платити» — продублюй реквізити
6. НІКОЛИ не включай вартість тренера в суму бронювання корту! Тренер = тільки адмін
7. НІКОЛИ не включай вартість ракеток/м'ячів у суму бронювання! Вони оплачуються окремо на рецепції
8. Сума бронювання = ТІЛЬКИ вартість корту × тривалість. Нічого більше!`;

// OpenAI function definitions for the bot
const OPENAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "check_court_availability",
      description: "Перевірити доступність кортів LEV Padel на конкретну дату. Повертає вільні слоти з цінами.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Дата у форматі YYYY-MM-DD, наприклад 2026-08-30",
          },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_lead",
      description:
        "Створити ліда в CRM LuckyFit. Викликати ОДИН РАЗ після підтвердження бронювання або запису на тренування. Не викликати без імені та телефону.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Прізвище та ім'я клієнта" },
          phone: { type: "string", description: "Номер телефону, наприклад +380501234567" },
          instagram: { type: "string", description: "Instagram нік клієнта (без @)" },
          notes: {
            type: "string",
            description: "Деталі бронювання/тренування. БЕЗ емодзі!",
          },
        },
        required: ["name", "phone"],
      },
    },
  },
];

// ─── AI Processing (OpenAI with function calling) ─────────

async function callOpenAI(messages, senderId, depth = 0) {
  // Safety: max 5 recursive calls
  if (depth > 5) {
    return "Вибачте, сталася помилка обробки. Спробуйте ще раз 😊";
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "system", content: `Сьогодні: ${new Date().toLocaleDateString("uk-UA", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Europe/Kyiv" })}. Поточний час: ${new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" })}.\n\n${BOT_SYSTEM_PROMPT}` }, ...messages],
        tools: OPENAI_TOOLS,
        tool_choice: "auto",
        temperature: 0.7,
        max_tokens: 1200,
      }),
    });

    const data = await res.json();

    if (data.error) {
      console.error("[OpenAI] API Error:", data.error);
      return "Вибачте, сталася тимчасова помилка. Зателефонуйте +380 (77) 732 00 00 😊";
    }

    const choice = data.choices[0];
    const msg = choice.message;

    // Handle tool calls
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Ensure content is never null (OpenAI requirement for some models)
      messages.push({ ...msg, content: msg.content || "" });

      for (const toolCall of msg.tool_calls) {
        let args;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: "Помилка: невалідні аргументи",
          });
          continue;
        }

        let result;

        if (toolCall.function.name === "check_court_availability") {
          console.log(`[Bot] Checking availability for ${args.date}`);
          const avail = await checkCourtAvailability(args.date);
          result = avail.error
            ? avail.text
            : JSON.stringify({ date: avail.date, courts: avail.courts }, null, 2);
        } else if (toolCall.function.name === "create_lead") {
          // Enforce once-only rule
          if (leadCreated.get(senderId)) {
            console.log(`[Bot] Lead already created for ${senderId}, skipping`);
            result = "Лід вже створений раніше в цьому діалозі. Не створюй повторно.";
          } else {
            // Validate: reject placeholder/fake data
            const fakePat = /XXXX|user_instagram|example|test_user|приклад/i;
            if (fakePat.test(args.phone) || fakePat.test(args.instagram || "") || fakePat.test(args.name)) {
              console.warn(`[Bot] Rejected fake lead data: ${args.name}, ${args.phone}`);
              result = "ПОМИЛКА: Ти передав тестові/вигадані дані. Використовуй ТІЛЬКИ реальні дані від клієнта!";
            } else {
              console.log(`[Bot] Creating lead: ${args.name}, ${args.phone}`);
              // Mark as created BEFORE the call to prevent double-send
              leadCreated.set(senderId, true);
              const leadResult = await createLeadInCRM(args);
              if (leadResult.success) {
                result = "Лід успішно створено в CRM! Адміністратор отримав сповіщення в Telegram.";
              } else {
                result = `Помилка CRM: ${leadResult.error}. Адміністратор все одно отримав сповіщення — заявку обробить.`;
              }
            }
          }
        } else {
          result = "Невідома функція";
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      // Call AI again with tool results
      return callOpenAI(messages, senderId, depth + 1);
    }

    return msg.content || "Вибачте, не зрозумів. Напишіть ваше питання ще раз 😊";
  } catch (err) {
    console.error("[OpenAI] Request failed:", err.message);
    return "Вибачте, сталася тимчасова помилка. Зателефонуйте +380 (77) 732 00 00 😊";
  }
}

async function processMessage(senderId, userTexts, imageDataUrls = []) {
  cleanConversations();

  let conv = conversations.get(senderId);
  if (!conv) {
    conv = { messages: [], lastActivity: Date.now() };
    conversations.set(senderId, conv);
  }
  conv.lastActivity = Date.now();

  // Combine multiple messages into one (handles rapid sequential messages)
  const combinedText = userTexts.join("\n");

  // Build message content — text + optional images (GPT-4o vision)
  if (imageDataUrls.length > 0) {
    const content = [];
    if (combinedText.trim()) {
      content.push({ type: "text", text: combinedText });
    }
    for (const dataUrl of imageDataUrls) {
      content.push({ type: "image_url", image_url: { url: dataUrl, detail: "low" } });
    }
    if (content.length === imageDataUrls.length) {
      // No text — add context hint
      content.unshift({ type: "text", text: "[Клієнт надіслав зображення]" });
    }
    conv.messages.push({ role: "user", content });
  } else {
    conv.messages.push({ role: "user", content: combinedText });
  }

  // Keep last 20 messages for context window
  if (conv.messages.length > 20) {
    conv.messages = conv.messages.slice(-20);
  }

  try {
    // Deep copy messages for OpenAI call (tool_calls are added in-place)
    const msgCopy = JSON.parse(JSON.stringify(conv.messages));
    const response = await callOpenAI(msgCopy, senderId);
    conv.messages.push({ role: "assistant", content: response });
    return response;
  } catch (err) {
    console.error("[Bot] Processing error:", err);
    return "Вибачте, сталася тимчасова помилка. Спробуйте ще раз або зателефонуйте +380 (77) 732 00 00 😊";
  }
}

// ─── Image Download (for GPT-4o Vision) ─────────────────

async function downloadImageAsBase64(imageUrl) {
  try {
    console.log("[Vision] Downloading image from Instagram...");
    const imgRes = await fetch(imageUrl, {
      headers: { Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}` },
    });
    if (!imgRes.ok) {
      console.error(`[Vision] Failed to download image: ${imgRes.status}`);
      return null;
    }
    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    console.log(`[Vision] Image downloaded: ${buffer.byteLength} bytes, ${contentType}`);
    return `data:${contentType};base64,${base64}`;
  } catch (err) {
    console.error("[Vision] Download failed:", err.message);
    return null;
  }
}

// ─── Voice Message Transcription (OpenAI Whisper) ────────

async function transcribeAudio(audioUrl) {
  try {
    console.log("[Whisper] Downloading audio from Instagram...");
    // Download audio from Instagram (requires access token)
    const audioRes = await fetch(audioUrl, {
      headers: { Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}` },
    });
    if (!audioRes.ok) {
      console.error(`[Whisper] Failed to download audio: ${audioRes.status}`);
      return null;
    }
    const audioBuffer = await audioRes.arrayBuffer();
    console.log(`[Whisper] Audio downloaded: ${audioBuffer.byteLength} bytes`);

    // Send to OpenAI Whisper API
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: "audio/mp4" }), "voice.mp4");
    formData.append("model", "whisper-1");
    formData.append("language", "uk"); // Ukrainian

    const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    });

    const whisperData = await whisperRes.json();
    if (whisperData.text) {
      console.log(`[Whisper] Transcribed: "${whisperData.text.substring(0, 80)}..."`);
      return whisperData.text;
    } else {
      console.error("[Whisper] No text in response:", whisperData);
      return null;
    }
  } catch (err) {
    console.error("[Whisper] Transcription failed:", err.message);
    return null;
  }
}

// ─── Instagram Messaging API ─────────────────────────────

async function sendInstagramMessage(recipientId, text) {
  if (!INSTAGRAM_ACCESS_TOKEN) {
    console.error("[Instagram] No access token configured");
    return;
  }

  // Instagram DM limit is ~1000 chars per message
  const MAX_LEN = 950;
  const chunks = [];

  if (text.length <= MAX_LEN) {
    chunks.push(text);
  } else {
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_LEN) {
        chunks.push(remaining);
        break;
      }
      // Find a clean split point
      let splitAt = remaining.lastIndexOf("\n\n", MAX_LEN);
      if (splitAt < MAX_LEN * 0.3) splitAt = remaining.lastIndexOf("\n", MAX_LEN);
      if (splitAt < MAX_LEN * 0.3) splitAt = remaining.lastIndexOf(". ", MAX_LEN);
      if (splitAt < MAX_LEN * 0.3) splitAt = MAX_LEN;
      chunks.push(remaining.substring(0, splitAt + 1).trim());
      remaining = remaining.substring(splitAt + 1).trim();
    }
  }

  for (let i = 0; i < chunks.length; i++) {
    try {
      // Use Instagram Graph API for Instagram DMs
      const res = await fetch(`https://graph.instagram.com/v26.0/me/messages?access_token=${INSTAGRAM_ACCESS_TOKEN}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: chunks[i] },
        }),
      });

      const data = await res.json();
      if (data.error) {
        console.error(`[Instagram] Send error (chunk ${i + 1}/${chunks.length}):`, data.error);
      } else {
        console.log(`[Instagram] Message sent (chunk ${i + 1}/${chunks.length}) to ${recipientId}`);
        // Track sent text for echo detection (distinguish bot echo from admin echo)
        let sentList = botSentTexts.get(recipientId);
        if (!sentList) {
          sentList = [];
          botSentTexts.set(recipientId, sentList);
        }
        sentList.push({ text: chunks[i].trim().substring(0, 100), time: Date.now() });
        // Auto-clean old entries after 2 min
        setTimeout(() => {
          const list = botSentTexts.get(recipientId);
          if (list) {
            const idx = list.findIndex(e => e.text === chunks[i].trim().substring(0, 100));
            if (idx !== -1) list.splice(idx, 1);
            if (list.length === 0) botSentTexts.delete(recipientId);
          }
        }, 120000);
      }

      // Small delay between chunks to maintain order
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      console.error("[Instagram] Send failed:", err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  INSTAGRAM LOGIN FOR BUSINESS (OAuth flow)
// ═══════════════════════════════════════════════════════════

// Step 1: Redirect user to Facebook Login (works for Instagram business accounts)
app.get("/auth/instagram", (_req, res) => {
  const redirectUri = `${RAILWAY_URL}/auth/callback`;
  const scope = "pages_show_list,pages_manage_metadata,pages_messaging,business_management";
  const url = `https://www.facebook.com/v26.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}`;
  console.log("[Auth] Redirecting to Facebook Login for Instagram permissions...");
  res.redirect(url);
});

// Step 2: Handle callback — exchange code for tokens
app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    console.error("[Auth] Authorization denied or failed:", error);
    return res.status(400).send("Авторизація скасована. Спробуйте ще раз.");
  }

  try {
    const redirectUri = `${RAILWAY_URL}/auth/callback`;

    // Exchange code for user access token via Facebook
    const tokenRes = await fetch(
      `https://graph.facebook.com/v26.0/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`
    );
    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      console.error("[Auth] Token exchange error:", tokenData.error);
      return res.status(400).send(`Помилка: ${tokenData.error.message}`);
    }

    console.log("[Auth] User access token received");
    const userToken = tokenData.access_token;

    // Get long-lived user token (60 days)
    const longRes = await fetch(
      `https://graph.facebook.com/v26.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${userToken}`
    );
    const longData = await longRes.json();
    const longUserToken = longData.access_token || userToken;

    // Get user's Pages
    const pagesRes = await fetch(`https://graph.facebook.com/v26.0/me/accounts?access_token=${longUserToken}`);
    const pagesData = await pagesRes.json();
    console.log("[Auth] Pages found:", pagesData.data?.length || 0);

    // Find LEV Padel Club page (ID 846483408547279) and subscribe it
    const levPadelPage = (pagesData.data || []).find(p => p.id === "846483408547279");

    if (levPadelPage) {
      // Subscribe this page to the app webhooks for messaging
      const subRes = await fetch(
        `https://graph.facebook.com/v26.0/${levPadelPage.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks&access_token=${levPadelPage.access_token}`,
        { method: "POST" }
      );
      const subData = await subRes.json();

      console.log(`[Auth] ✅ LEV Padel Club page found!`);
      console.log(`[Auth] Page token: ${levPadelPage.access_token}`);
      console.log(`[Auth] Webhook subscribed: ${JSON.stringify(subData)}`);

      res.send(`
        <h1>✅ LEV Padel Club підключено!</h1>
        <p><b>Page ID:</b> ${levPadelPage.id}</p>
        <p><b>Instagram:</b> @padel.lviv (ID: 17841477102687440)</p>
        <p><b>Webhook підписка:</b> ${subData.success ? "✅ Активна" : "❌ " + JSON.stringify(subData)}</p>
        <p><b>Page Access Token (для бота):</b></p>
        <textarea style="width:100%;height:120px;font-size:12px">${levPadelPage.access_token}</textarea>
        <br><br>
        <p>⬆️ Скопіюйте цей токен і скиньте мені в чат — я оновлю налаштування бота.</p>
      `);
    } else {
      // Show all pages so user can identify
      const pagesList = (pagesData.data || []).map(p => {
        return `<li><b>${p.name}</b> (ID: ${p.id})<br><textarea style="width:100%;height:60px;font-size:11px">${p.access_token}</textarea></li>`;
      }).join("");
      res.send(`
        <h1>⚠️ LEV Padel Club не знайдено</h1>
        <p>Знайдено ${pagesData.data?.length || 0} сторінок. Скопіюйте токен потрібної:</p>
        <ul>${pagesList}</ul>
      `);
    }
  } catch (err) {
    console.error("[Auth] Fatal error:", err.message);
    res.status(500).send(`Серверна помилка: ${err.message}`);
  }
});

// ─── Webhook Verification (Meta challenge) ────────────────

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === INSTAGRAM_VERIFY_TOKEN) {
    console.log("[Webhook] ✅ Verified successfully!");
    return res.status(200).send(challenge);
  }

  console.warn("[Webhook] ❌ Verification failed — token mismatch");
  return res.status(403).json({ error: "Forbidden" });
});

// ─── Webhook Message Handler ──────────────────────────────

app.post("/webhook", async (req, res) => {
  // Always respond 200 immediately (Meta retries on non-200)
  res.status(200).send("EVENT_RECEIVED");

  if (!OPENAI_API_KEY || !INSTAGRAM_ACCESS_TOKEN) {
    console.warn("[Webhook] Skipping — missing OPENAI_API_KEY or INSTAGRAM_ACCESS_TOKEN");
    return;
  }

  const body = req.body;
  if (body.object !== "instagram") return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      // Skip read receipts and delivery confirmations
      if (event.read || event.delivery) continue;

      // ── Echo handling: distinguish bot echo from admin echo ──
      if (event.message?.is_echo) {
        const echoRecipient = event.recipient?.id;
        const echoText = (event.message?.text || "").trim().substring(0, 100);

        if (echoRecipient && echoText) {
          const sentList = botSentTexts.get(echoRecipient);
          const matchIdx = sentList
            ? sentList.findIndex(e => echoText === e.text)
            : -1;

          if (matchIdx !== -1) {
            // Bot echo — matches text we sent → remove from tracking, skip
            sentList.splice(matchIdx, 1);
            if (sentList.length === 0) botSentTexts.delete(echoRecipient);
          } else {
            // Admin echo — text we did NOT send → activate human takeover
            humanTakeover.set(echoRecipient, Date.now());
            console.log(`[Takeover] ✅ Admin replied to ${echoRecipient}, bot paused for 2 hours`);
          }
        }
        continue; // Always skip echo messages (don't process as user input)
      }

      const senderId = event.sender?.id;
      if (!senderId) continue;

      // Learn the bot's webhook IGSID from recipient field of incoming messages
      if (event.recipient?.id) BOT_IDS.add(event.recipient.id);

      // Skip messages from the bot itself (multiple ID formats possible)
      if (BOT_IDS.has(senderId)) continue;

      // ── Human takeover check: if admin recently replied, bot stays silent ──
      const takeoverTime = humanTakeover.get(senderId);
      if (takeoverTime && (Date.now() - takeoverTime < HUMAN_TAKEOVER_TTL)) {
        console.log(`[Takeover] Bot paused for ${senderId} — admin handling (${Math.round((Date.now() - takeoverTime) / 60000)} min ago)`);
        continue;
      } else if (takeoverTime) {
        // Expired — clean up and let bot respond
        humanTakeover.delete(senderId);
        console.log(`[Takeover] Pause expired for ${senderId}, bot resuming`);
      }

      let messageText;
      let imageDataUrl = null; // For GPT-4o vision

      if (event.message?.text) {
        messageText = event.message.text;
      } else if (event.message?.attachments) {
        const types = event.message.attachments.map((a) => a.type);

        // Voice messages — transcribe with Whisper
        const audioAttachment = event.message.attachments.find(a => a.type === "audio");
        if (audioAttachment && audioAttachment.payload?.url) {
          console.log(`[Webhook] Voice message from ${senderId}, transcribing...`);
          const transcription = await transcribeAudio(audioAttachment.payload.url);
          if (transcription) {
            messageText = transcription;
            console.log(`[Webhook] Voice transcribed: "${transcription.substring(0, 80)}"`);
          } else {
            messageText = `[Клієнт надіслав голосове повідомлення, яке не вдалося розпізнати]`;
          }
        }
        // Images — download for GPT-4o vision
        else if (types.includes("image")) {
          const imgAttachment = event.message.attachments.find(a => a.type === "image");
          if (imgAttachment?.payload?.url) {
            console.log(`[Webhook] Image from ${senderId}, downloading for vision...`);
            imageDataUrl = await downloadImageAsBase64(imgAttachment.payload.url);
          }
          messageText = event.message.text || ""; // Image may have caption text
        }
        // Instagram sends shares/reels/stories as various types including "unsupported_type"
        else {
          const shareTypes = ["share", "story_mention", "reel", "ig_reel", "media_share", "unsupported_type"];
          const hasShare = types.some(t => shareTypes.includes(t));
          if (hasShare) {
            // Anti-duplicate: skip if we already responded to a share from this user recently
            const lastShare = lastShareResponse.get(senderId);
            if (lastShare && (Date.now() - lastShare < SHARE_RESPONSE_COOLDOWN)) {
              console.log(`[Webhook] Duplicate share from ${senderId}, skipping (${Math.round((Date.now() - lastShare) / 1000)}s ago)`);
              continue;
            }
            lastShareResponse.set(senderId, Date.now());
            messageText = `[Клієнт поділився публікацією/reels або згадав нас]`;
          } else {
            messageText = `[Клієнт надіслав: ${types.join(", ")}]`;
          }
        }
      } else if (event.postback) {
        // Quick reply / button postback
        messageText = event.postback.payload || event.postback.title || "[кнопка]";
      } else {
        continue;
      }

      console.log(`[Webhook] Message from ${senderId}: ${(messageText || "[image]").substring(0, 80)}`);

      // ── Message batching: wait for more messages ──
      let queue = messageQueues.get(senderId);
      if (!queue) {
        queue = { messages: [], images: [], timer: null };
        messageQueues.set(senderId, queue);
      }

      if (messageText) queue.messages.push(messageText);
      if (imageDataUrl) queue.images.push(imageDataUrl);

      if (queue.timer) clearTimeout(queue.timer);
      queue.timer = setTimeout(async () => {
        const texts = [...queue.messages];
        const images = [...queue.images];
        queue.messages = [];
        queue.images = [];
        messageQueues.delete(senderId);

        console.log(`[Bot] Processing ${texts.length} text(s) + ${images.length} image(s) from ${senderId}`);

        try {
          const response = await processMessage(senderId, texts, images);
          await sendInstagramMessage(senderId, response);
        } catch (err) {
          console.error("[Bot] Fatal error:", err);
          try {
            await sendInstagramMessage(
              senderId,
              "Сталася помилка. Зателефонуйте +380 (77) 732 00 00 або напишіть пізніше 😊"
            );
          } catch {}
        }
      }, MESSAGE_BATCH_DELAY);
    }
  }
});

// ═══════════════════════════════════════════════════════════
//  MCP SERVER (SendPulse compatibility — unchanged)
// ═══════════════════════════════════════════════════════════

function createMcpServer() {
  const server = new McpServer({
    name: "lev-padel",
    version: "1.0.0",
  });

  // Tool 1: Check court availability
  server.tool(
    "check_court_availability",
    "Перевірити доступність кортів падел-клубу LEV Padel на конкретну дату. Повертає список кортів з вільними слотами, цінами та часом.",
    {
      date: z
        .string()
        .describe("Дата для перевірки у форматі YYYY-MM-DD, наприклад 2026-08-25"),
    },
    async ({ date }) => {
      const result = await checkCourtAvailability(date);
      if (result.error) {
        return {
          content: [{ type: "text", text: result.text }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    }
  );

  // Tool 2: Create lead in LuckyFit CRM
  server.tool(
    "create_lead",
    "Створити нового ліда (заявку на бронювання) в CRM LuckyFit. Викликати після того як клієнт підтвердив бронювання та надав контактні дані.",
    {
      name: z.string().describe("Ім'я клієнта (ім'я та прізвище)"),
      phone: z
        .string()
        .describe("Номер телефону клієнта (обов'язково), наприклад +380501234567"),
      instagram: z
        .string()
        .optional()
        .describe("Instagram нік клієнта (без @), наприклад natalia_kornutiak"),
      notes: z
        .string()
        .optional()
        .describe(
          "Деталі бронювання: дата, час, номер корту, кількість гравців"
        ),
    },
    async ({ name, phone, instagram, notes }) => {
      const result = await createLeadInCRM({ name, phone, instagram, notes });

      if (!result.success) {
        return {
          content: [
            {
              type: "text",
              text: `Помилка CRM, але адміністратор отримав сповіщення і обробить заявку.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Лід успішно створено в CRM! Заявка зафіксована. Адміністратор отримав сповіщення в Telegram.`,
          },
        ],
      };
    }
  );

  return server;
}

// ─── Streamable HTTP transport (POST /sse) ────────────────
const httpSessions = new Map();

app.post("/sse", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && httpSessions.has(sessionId)) {
    const { transport } = httpSessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    httpSessions.set(transport.sessionId, { transport, server });
  }
});

app.get("/sse", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && httpSessions.has(sessionId)) {
    const { transport } = httpSessions.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }

  console.log("[MCP] New legacy SSE connection");
  const transport = new SSEServerTransport("/message", res);
  const sseSessions = app.locals.sseSessions || {};
  sseSessions[transport.sessionId] = transport;
  app.locals.sseSessions = sseSessions;

  res.on("close", () => {
    delete sseSessions[transport.sessionId];
  });

  const server = createMcpServer();
  await server.connect(transport);
});

app.delete("/sse", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && httpSessions.has(sessionId)) {
    const { transport } = httpSessions.get(sessionId);
    await transport.handleRequest(req, res);
    httpSessions.delete(sessionId);
    return;
  }
  res.status(404).json({ error: "Session not found" });
});

app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId;
  const sseSessions = app.locals.sseSessions || {};
  const transport = sseSessions[sessionId];

  if (!transport) {
    return res.status(404).json({ error: "Session not found" });
  }

  await transport.handlePostMessage(req, res);
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && httpSessions.has(sessionId)) {
    const { transport } = httpSessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    httpSessions.set(transport.sessionId, { transport, server });
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && httpSessions.has(sessionId)) {
    const { transport } = httpSessions.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No active session. Send POST first." });
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && httpSessions.has(sessionId)) {
    const { transport } = httpSessions.get(sessionId);
    await transport.handleRequest(req, res);
    httpSessions.delete(sessionId);
    return;
  }
  res.status(404).json({ error: "Session not found" });
});

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ Lev Padel server v3.0 running on port ${PORT}`);
  console.log(`   MCP:        /sse, /mcp (POST/GET/DELETE)`);
  console.log(`   Webhook:    /webhook (GET verify, POST messages)`);
  console.log(`   LuckyFit:   ${LUCKYFIT_API_KEY ? "✅ configured" : "⚠️ NOT SET"}`);
  console.log(`   Instagram:  ${INSTAGRAM_ACCESS_TOKEN ? "✅ configured" : "⚠️ NOT SET"}`);
  console.log(`   OpenAI:     ${OPENAI_API_KEY ? "✅ configured" : "⚠️ NOT SET"}`);
  await fetchBotId();
});
