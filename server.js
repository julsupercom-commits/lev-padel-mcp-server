import express from "express";
import cors from "cors";
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

// ─── Conversation Memory ─────────────────────────────────
const conversations = new Map(); // senderId -> { messages: [], lastActivity }
const CONVERSATION_TTL = 30 * 60 * 1000; // 30 min
const leadCreated = new Map(); // senderId -> true (enforce once-only rule)

// Message batching: wait for rapid sequential messages
const messageQueues = new Map(); // senderId -> { messages: [], timer }
const MESSAGE_BATCH_DELAY = 3000; // 3 sec

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
    return { error: false, data };
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
        if (instagram) tgText += `📸 Instagram: @${instagram}\n`;
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
        if (instagram) tgText += `📸 Instagram: @${instagram}\n`;
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
    version: "2.0.0",
    instagram_bot: INSTAGRAM_ACCESS_TOKEN ? "configured" : "not configured",
  });
});

// ═══════════════════════════════════════════════════════════
//  INSTAGRAM BOT — Webhook + AI + Messaging
// ═══════════════════════════════════════════════════════════

// Bot system prompt (full prompt from lev-padel-bot-prompt-v2.md)
const BOT_SYSTEM_PROMPT = `# AI-бот LEV Padel Club · Instagram DM

## РОЛЬ

Ти — привітний менеджер з бронювань LEV Padel Club у Львові. Відповідаєш в Instagram Direct, допомагаєш з бронюванням кортів та записом на тренування. Спілкуєшся українською, дружнім тоном, з емоджі (🎾✅👌😊). Відповідай мовою клієнта (укр/рос).

## ПРАВИЛА

1. Завершуй повідомлення закриваючим питанням — «Бронюємо?», «На який час?»
2. Якщо час/тренер зайнятий — ЗАВЖДИ пропонуй альтернативу: інший час, інший день або інший тренер. Ніколи не кажи просто «всі зайняті» без пропозиції альтернативи
3. Будь стислим — це чат, не email
4. Не вигадуй інформацію — не знаєш, чесно скажи і передай адміну
5. Вітання — «Вітаю!» або «Привіт!» (не «Доброго дня» — клієнт може писати вночі)
6. СТОП тільки після: прощання клієнта (одне коротке повідомлення і стоп), надсилання реквізитів, або підтвердження запису на тренування. Якщо ти запитав «Уточнити?» або чекаєш відповідь — НЕ зупиняйся, продовжуй відповідати на нові повідомлення клієнта. Коли клієнт каже «Добре», «Ок», «Дякую» на твоє фінальне повідомлення — це прощання. Відповідай ОДНИМ коротким реченням без питань і СТОП
7. Не питай «Напишете?» — просто попроси дані і чекай
8. Якщо клієнт надсилає фото/зображення — ти не можеш їх бачити. Не зависай! Відповідай: «Дякую за фото! На жаль, я не можу переглядати зображення 😊 Напишіть, будь ласка, текстом — чим можу допомогти?» Якщо з контексту розмови зрозуміло що клієнт мав на увазі (наприклад, раніше обговорювали тренера) — продовжуй діалог на основі контексту, не чекаючи пояснення фото
9. НІКОЛИ не пиши англійською. Всі повідомлення клієнту — тільки українською або російською (мовою клієнта). Ніяких внутрішніх нотаток, коментарів чи інструкцій у повідомленнях
10. Якщо клієнт надіслав кілька повідомлень поспіль — прочитай ВСІ повідомлення і дай ОДНУ відповідь на всі разом. Не ігноруй жодне повідомлення. Не зависай

## КЛУБ

- Адреса: вул. Пластова 7, Львів · https://maps.app.goo.gl/BC1i6m3LBTekDBmHA
- Графік: Пн-Нд 8:00–23:00
- Телефон: +380 (77) 732 00 00
- Сайт: www.levpadel.com.ua · Бронювання: www.levpadel.com.ua/book
- Instagram: @padel.lviv · Колаборації: @padel.lviv.coop

Що таке падел: ракетковий спорт (теніс + сквош), грають 2×2 на корті 10×20м зі стінками. Ракетки суцільні, подача знизу. Підходить для будь-якого рівня.

Зручності в клубі:
- Душові кабіни — після гри можна повноцінно прийняти душ
- Роздягальні з індивідуальними шафами (закриваються)
- Санвузли, умивальники, фени
- Міні-кафе з лаунж-зоною — кава, чай, снеки, міні-бар (є навіть пиво)
- Wi-Fi
- Автономне електропостачання — клуб працює навіть при відключенні світла

## КОРТИ (10 шт.)

Усі корти від іспанського Padel Galis. Різниця — у покритті.

Преміум корти (Court 1, Court 2, Court 7, Purple 8, Purple 9): Пік 1400 грн/год, Офпік 1200 грн/год
Стандарт корти (Court 3, Court 4, Court 5, Blue 6): Пік 1300 грн/год, Офпік 1100 грн/год
Одиночний корт (1×1): Пік 1100 грн/год, Офпік 800 грн/год

- Офпік: Пн-Пт 8:00–17:00
- Пік: Пн-Пт 17:00–23:00 + Сб-Нд весь день
- Тривалість: 60 / 90 / 120 хв
- Корти 2×2 підходять для гри і вчотирьох, і вдвох — це стандартний розмір падел-корту (10×20м), комфортно грати від 2 до 4 гравців. Одиночний корт (1×1) — менший і дешевший, спеціально для гри 1 на 1

## ІНВЕНТАР (оренда на рецепції, оплата на місці)

- Аматорська ракетка — 100 грн/год, Професійна — 150 грн/год, Преміум — 250 грн/год, М'ячі — 50 грн/тубус
- В клубі є магазин з ракетками, кросівками, формою
- НЕ питай про інвентар під час бронювання! Згадуй тільки після підтвердження оплати або коли клієнт сам питає

## ТРЕНУВАННЯ

4 формати (ціна за тренера, корт окремо):
- Індивідуальне (1 гравець + тренер)
- Спліт (2 гравці + тренер)
- Ігрове (гра з тренером)
- Спліт +1/2 (3-4 гравці + тренер)

Бот НЕ продає тренування і НЕ бронює тренерів! Тренери мають свій графік, який перевіряє тільки адміністратор. Якщо клієнт питає про тренерів, формати чи ціни — консультуй. Але НЕ питай на який час/дату. Для запису на тренування — одразу проси контакти і передавай адміну.

## ОПЛАТА

- Бронювання підтверджується тільки після передоплати (1 год на оплату)
- Готівка: ТІЛЬКИ якщо клієнт САМ просить оплатити готівкою — тоді для першого бронювання можна зробити виняток: оплата готівкою в клубі без передоплати. Далі — передоплата або депозит. НЕ пропонуй готівку першим
- Якщо клієнт каже «оплачу завтра/пізніше»: — «Добре! Чекаємо вашу оплату до 9:00 ранку, щоб бронювання залишилось за вами ✅». Без передоплати НЕ бронюємо
- Ракетки та м'ячі — оплата на місці в клубі (НЕ входять у передоплату)

Реквізити для оплати корту:
ФОП Саврук Олена Іванівна
UA713220010000026006370018011
ІПН 3715805281
АТ КБ «УНІВЕРСАЛ БАНК»
Призначення: «За оренду корту»

## СЦЕНАРІЙ: БРОНЮВАННЯ КОРТУ

1. Уточни: дата, час, тривалість, тип корту
2. Виклич check_court_availability(date) → покажи вільні слоти
3. Клієнт обрав → запитай контакти: «Щоб зафіксувати — скиньте прізвище, ім'я та номер телефону 😊»
4. Виклич create_lead(name, phone, instagram, notes) ОДИН РАЗ:
   notes = "Instagram DM | Бронювання: [КОРТ], [ДАТА] о [ЧАС]-[ЧАС ЗАКІНЧЕННЯ]. До оплати: [СУМА] грн" (БЕЗ емодзі в notes!)
5. Надішли повідомлення — реквізити:
   [ІМ'Я], ваше бронювання зафіксовано! 🎾

   [КОРТ] · [ДАТА] · [ЧАС] ([ТРИВАЛІСТЬ])
   До оплати: [СУМА] грн

   Реквізити для оплати:
   ФОП Саврук Олена Іванівна
   UA713220010000026006370018011
   ІПН 3715805281
   АТ КБ «УНІВЕРСАЛ БАНК»
   Призначення: «За оренду корту»

   Бронювання без оплати діє одну годину.

   Якщо плани зміняться — скасуйте за 24 години до початку, і кошти повернуться на ваш депозит у клубі для наступного візиту. При пізнішому скасуванні повернення, на жаль, неможливе.

   Для завершення бронювання, будь ласка, здійсніть оплату та надішліть скріншот квитанції у відповідь 💛🎾

   P.S. Без передоплати клуб не може гарантувати, що корт чекатиме саме на вас.
6. СТОП. Більше не пиши.

Коли клієнт надсилає підтвердження оплати (скріншот, фото квитанції, «оплатив»):
Дякуємо! 😊 Бронювання зафіксоване. Адміністратор відмітить оплату після зарахування коштів ✅

На рецепції можна взяти в оренду ракетки та м'ячі 🎾

Завантажуй наш додаток Lev Padel — зручне бронювання без зайвих зусиль!
iPhone: https://bit.ly/4y59EVw
Android: https://bit.ly/4zMFqZg

Наше ком'юніті в Telegram — новини, турніри, набори в групи. Приєднуйтесь!
https://t.me/+-j5dqQtZJcozYjUy

Чекаємо вас на Пластова 7! 💛🎾
→ СТОП.

## СЦЕНАРІЙ: ТРЕНУВАННЯ

Клієнт хоче тренування / тренера / індивідуальне / спліт / ігрове:
1. НЕ показуй список тренерів, НЕ показуй ціни, НЕ питай формат/час/дату
2. Одразу попроси контакти: «Щоб записати вас на тренування — скиньте, будь ласка, прізвище, ім'я та номер телефону 😊 Адміністратор зв'яжеться з вами та підбере тренера і зручний час!»
3. Отримав контакти → create_lead(name, phone, instagram, notes) з notes = "Instagram DM | Хоче тренування з тренером. Зв'язатись з клієнтом!" (БЕЗ емодзі в notes!)
4. Фінальне повідомлення: «Заявку зафіксовано! Адміністратор зв'яжеться з вами найближчим часом 😊» → СТОП

Клієнт питає «що таке спліт?» або «які є формати?» (загальне питання):
- Коротко поясни формат (індивідуальне = 1+тренер, спліт = 2+тренер, ігрове = гра з тренером, спліт +1/2 = 3-4 гравці + тренер)
- НЕ показуй ціни тренерів, НЕ показуй таблицю
- Скажи: «Для запису на тренування залиште прізвище, ім'я та телефон — адміністратор підбере тренера та зручний час 😊»

## СЦЕНАРІЙ: ГРУПОВІ ЗАНЯТТЯ

Постійних груп з фіксованим розкладом НЕ існує. Групи формуються за запитом клієнтів через Telegram-канал клубу.

Коли клієнт питає про групові заняття / хоче в групу / шукає компанію для гри:
1. Поясни що групи формуються за запитом — коли набирається група, тренер призначає час
2. Запропонуй два варіанти:
   — Приєднатись до Telegram-каналу LEV Padel: https://t.me/+-j5dqQtZJcozYjUy
   — Або залишити ім'я + телефон — адміністратор зв'яжеться, як формуватиметься група
3. Якщо клієнт залишає контакти → create_lead(name, phone, notes) з notes = "Instagram DM | Хоче в групу, чекає набір"

## ІНШІ ТЕМИ

- Турніри/Padel Time: рівні D, D+, C, C-. Реєстрація в Telegram-групі або pado.app
- UGC/Колаборації: направляй в @padel.lviv.coop
- Корпоративи: збери к-сть людей + дату → create_lead → передай адміну
- Дитячий падел: є! Деталі за тел. +380 (77) 732 00 00

## ПЕРЕДАЧА АДМІНУ

Передавай адміну якщо: скарга, повернення коштів, 3+ корти, корпоратив, розклад тренера, клієнт просить людину, не знаєш відповіді.

## КРИТИЧНІ ПРАВИЛА

1. create_lead — СТРОГО ОДИН РАЗ за весь діалог. Якщо ти вже викликав create_lead — НІКОЛИ не викликай його знову в цьому ж діалозі, навіть якщо деталі змінились. Завжди передавай instagram нік клієнта
2. Без прізвища, імені та телефону — НЕ створюй лід. Якщо клієнт просто поділився постом, зробив репост або надіслав реакцію без тексту — НЕ створюй лід, просто привітайся
3. Після фінального повідомлення — СТОП
4. Якщо create_lead повернув помилку — скажи що заявка зафіксована, адмін обробить
5. Якщо клієнт питає «куди платити» після завершення — продублюй реквізити ще раз`;

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
        messages: [{ role: "system", content: BOT_SYSTEM_PROMPT }, ...messages],
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
      messages.push(msg);

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
            : JSON.stringify(avail.data, null, 2);
        } else if (toolCall.function.name === "create_lead") {
          // Enforce once-only rule
          if (leadCreated.get(senderId)) {
            console.log(`[Bot] Lead already created for ${senderId}, skipping`);
            result = "Лід вже створений раніше в цьому діалозі. Не створюй повторно.";
          } else {
            console.log(`[Bot] Creating lead: ${args.name}, ${args.phone}`);
            const leadResult = await createLeadInCRM(args);
            if (leadResult.success) {
              leadCreated.set(senderId, true);
              result = "Лід успішно створено в CRM! Адміністратор отримав сповіщення в Telegram.";
            } else {
              result = `Помилка CRM: ${leadResult.error}. Адміністратор все одно отримав сповіщення — заявку обробить.`;
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

async function processMessage(senderId, userTexts) {
  cleanConversations();

  let conv = conversations.get(senderId);
  if (!conv) {
    conv = { messages: [], lastActivity: Date.now() };
    conversations.set(senderId, conv);
  }
  conv.lastActivity = Date.now();

  // Combine multiple messages into one (handles rapid sequential messages)
  const combinedText = userTexts.join("\n");
  conv.messages.push({ role: "user", content: combinedText });

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
      // Use Facebook Graph API (works for both Messenger and Instagram DMs)
      const res = await fetch(`https://graph.facebook.com/v26.0/me/messages?access_token=${INSTAGRAM_ACCESS_TOKEN}`, {
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
  const scope = "instagram_basic,instagram_manage_messages,pages_show_list,pages_manage_metadata,business_management";
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

    // For each page, check if it has an Instagram business account
    let results = [];
    for (const page of (pagesData.data || [])) {
      const igRes = await fetch(
        `https://graph.facebook.com/v26.0/${page.id}?fields=instagram_business_account,name&access_token=${page.access_token}`
      );
      const igData = await igRes.json();

      if (igData.instagram_business_account) {
        // Subscribe this page to the app webhooks
        const subRes = await fetch(
          `https://graph.facebook.com/v26.0/${page.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks&access_token=${page.access_token}`,
          { method: "POST" }
        );
        const subData = await subRes.json();

        results.push({
          page_name: page.name,
          page_id: page.id,
          page_token: page.access_token,
          ig_account_id: igData.instagram_business_account.id,
          webhook_subscribed: subData.success || false,
        });

        console.log(`[Auth] ✅ Page "${page.name}" (${page.id}) → IG account ${igData.instagram_business_account.id}`);
        console.log(`[Auth] Page token: ${page.access_token}`);
        console.log(`[Auth] Webhook subscribed: ${subData.success}`);
      }
    }

    if (results.length > 0) {
      const r = results[0];
      res.send(`
        <h1>✅ Instagram підключено!</h1>
        <h2>Сторінка: ${r.page_name}</h2>
        <p><b>Page ID:</b> ${r.page_id}</p>
        <p><b>Instagram Account ID:</b> ${r.ig_account_id}</p>
        <p><b>Webhook підписка:</b> ${r.webhook_subscribed ? "✅ Активна" : "❌ Помилка"}</p>
        <p><b>Page Access Token (для бота):</b></p>
        <textarea style="width:100%;height:120px;font-size:12px">${r.page_token}</textarea>
        <br><br>
        <p>⬆️ Скопіюйте цей токен і скиньте мені в чат — я оновлю налаштування бота.</p>
        <p><small>Також виведено в логах Railway.</small></p>
      `);
    } else {
      res.send(`
        <h1>⚠️ Instagram акаунт не знайдено</h1>
        <p>Знайдено сторінок: ${pagesData.data?.length || 0}, але жодна не має підключеного Instagram бізнес-акаунту.</p>
        <p>Переконайтесь, що @padel.lviv підключений до Facebook-сторінки LEV Padel Club.</p>
        <h3>Знайдені сторінки:</h3>
        <ul>${(pagesData.data || []).map(p => `<li>${p.name} (ID: ${p.id})</li>`).join("")}</ul>
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
      // Skip echo (our own outgoing messages)
      if (event.message?.is_echo) continue;
      // Skip read receipts and delivery confirmations
      if (event.read || event.delivery) continue;

      const senderId = event.sender?.id;
      if (!senderId) continue;

      let messageText;

      if (event.message?.text) {
        messageText = event.message.text;
      } else if (event.message?.attachments) {
        // Image, sticker, audio, video — bot can't see these
        const types = event.message.attachments.map((a) => a.type).join(", ");
        messageText = `[Клієнт надіслав: ${types}]`;
      } else if (event.postback) {
        // Quick reply / button postback
        messageText = event.postback.payload || event.postback.title || "[кнопка]";
      } else {
        continue;
      }

      console.log(`[Webhook] Message from ${senderId}: ${messageText.substring(0, 80)}`);

      // ── Message batching: wait 3s for more messages ──
      let queue = messageQueues.get(senderId);
      if (!queue) {
        queue = { messages: [], timer: null };
        messageQueues.set(senderId, queue);
      }

      queue.messages.push(messageText);

      if (queue.timer) clearTimeout(queue.timer);
      queue.timer = setTimeout(async () => {
        const texts = [...queue.messages];
        queue.messages = [];
        messageQueues.delete(senderId);

        console.log(`[Bot] Processing ${texts.length} message(s) from ${senderId}`);

        try {
          const response = await processMessage(senderId, texts);
          await sendInstagramMessage(senderId, response);
        } catch (err) {
          console.error("[Bot] Fatal error:", err);
          try {
            await sendInstagramMessage(
              senderId,
              "Вибачте, сталася помилка. Зателефонуйте +380 (77) 732 00 00 або напишіть пізніше 😊"
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
app.listen(PORT, () => {
  console.log(`✅ Lev Padel server v2.0 running on port ${PORT}`);
  console.log(`   MCP:        /sse, /mcp (POST/GET/DELETE)`);
  console.log(`   Webhook:    /webhook (GET verify, POST messages)`);
  console.log(`   LuckyFit:   ${LUCKYFIT_API_KEY ? "✅ configured" : "⚠️ NOT SET"}`);
  console.log(`   Instagram:  ${INSTAGRAM_ACCESS_TOKEN ? "✅ configured" : "⚠️ NOT SET"}`);
  console.log(`   OpenAI:     ${OPENAI_API_KEY ? "✅ configured" : "⚠️ NOT SET"}`);
});
