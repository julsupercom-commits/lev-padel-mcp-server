import express from "express";
import cors from "cors";
import { BOT_SYSTEM_PROMPT } from "./bot-prompt.js";
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

    // Summarize: for each court, merge consecutive available slots into blocks
    const summary = (data.courts || []).map(court => {
      const blocks = [];
      let blockStart = null;
      let blockPrice = null;

      for (const slot of court.slots) {
        if (slot.available) {
          if (!blockStart) {
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
    version: "3.0.0",
    instagram_bot: INSTAGRAM_ACCESS_TOKEN ? "configured" : "not configured",
  });
});

// ═══════════════════════════════════════════════════════════
//  INSTAGRAM BOT — Webhook + AI + Messaging
// ═══════════════════════════════════════════════════════════

// Bot system prompt imported from bot-prompt.js

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
      // Skip echo (our own outgoing messages)
      if (event.message?.is_echo) continue;
      // Skip read receipts and delivery confirmations
      if (event.read || event.delivery) continue;

      const senderId = event.sender?.id;
      if (!senderId) continue;

      // Learn the bot's webhook IGSID from recipient field of incoming messages
      if (event.recipient?.id) BOT_IDS.add(event.recipient.id);

      // Skip messages from the bot itself (multiple ID formats possible)
      if (BOT_IDS.has(senderId)) continue;

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
app.listen(PORT, async () => {
  console.log(`✅ Lev Padel server v3.0 running on port ${PORT}`);
  console.log(`   MCP:        /sse, /mcp (POST/GET/DELETE)`);
  console.log(`   Webhook:    /webhook (GET verify, POST messages)`);
  console.log(`   LuckyFit:   ${LUCKYFIT_API_KEY ? "✅ configured" : "⚠️ NOT SET"}`);
  console.log(`   Instagram:  ${INSTAGRAM_ACCESS_TOKEN ? "✅ configured" : "⚠️ NOT SET"}`);
  console.log(`   OpenAI:     ${OPENAI_API_KEY ? "✅ configured" : "⚠️ NOT SET"}`);
  await fetchBotId();
});
