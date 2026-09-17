import express from "express";
import cors from "cors";
// BOT_SYSTEM_PROMPT defined inline below (Railway deployment compatibility)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomUUID } from "crypto";

// ─── Startup grace period: ignore echoes right after deploy ──
const SERVER_START_TIME = Date.now();
const ECHO_GRACE_PERIOD = 30000; // 30 sec

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
const LUCKYFIT_MCP_URL = "https://my.lucky.fitness/api/mcp";
let mcpReqId = 100;
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
const CONVERSATION_TTL = 24 * 60 * 60 * 1000; // 24 hours — bot remembers conversation for a full day
const leadCreated = new Map(); // senderId -> true (enforce once-only rule)

// Human takeover: when admin replies manually, bot pauses for 2 hours
const humanTakeover = new Map(); // recipientId -> timestamp when admin replied
const HUMAN_TAKEOVER_TTL = 2 * 60 * 60 * 1000; // 2 hours

// Track bot's sent message texts to distinguish bot echo from admin echo
// Key: recipientId, Value: array of { text: first 100 chars, time: timestamp }
const botSentTexts = new Map(); // legacy text-based (fallback)
const botSentMessageIds = new Set(); // PRIMARY: track message_ids sent by bot

// Anti-duplicate for share/mention responses
const lastShareResponse = new Map(); // senderId -> timestamp
const SHARE_RESPONSE_COOLDOWN = 60000; // 60 sec — ignore duplicate share events

// Anti-duplicate by message ID (Instagram sends story mentions as 2+ webhook events)
const processedMessageIds = new Set();
const MESSAGE_ID_TTL = 120000; // 2 min

// Anti-duplicate at SEND level: don't send same text to same recipient within 60s
const recentSentMessages = new Map(); // recipientId -> { text, time }
const SEND_DEDUP_TTL = 60000; // 60 sec

// Message batching: wait for rapid sequential messages
const messageQueues = new Map(); // senderId -> { messages: [], images: [], timer }
const MESSAGE_BATCH_DELAY = 5000; // 5 sec (people send 2-3 messages in a row)

// ─── Follow-up reminders for inactive booking conversations ──
const pendingFollowups = new Map(); // senderId -> { timer, type }
const FOLLOWUP_COURT_DELAY = 40 * 60 * 1000;  // 40 min after showing courts
const FOLLOWUP_PAYMENT_DELAY = 60 * 60 * 1000; // 60 min after lead created (waiting payment)

function setFollowup(senderId, type) {
  cancelFollowup(senderId); // clear any existing
  const delay = type === "court_shown" ? FOLLOWUP_COURT_DELAY : FOLLOWUP_PAYMENT_DELAY;
  const messages = {
    court_shown: "😊 Ви обирали корт — підкажіть, чи бронюємо? Якщо потрібна допомога з вибором, я тут 🎾",
    payment_pending: "😊 Нагадуємо про бронювання. Підкажіть, чи все гаразд з оплатою? Якщо є питання — пишіть, допоможемо 💚",
  };
  const timer = setTimeout(async () => {
    pendingFollowups.delete(senderId);
    // Don't send if admin took over or client already responded
    const takeover = humanTakeover.get(senderId);
    if (takeover && (Date.now() - takeover < HUMAN_TAKEOVER_TTL)) {
      console.log(`[Followup] Skipped for ${senderId} — admin handling`);
      return;
    }
    console.log(`[Followup] Sending "${type}" reminder to ${senderId}`);
    try {
      await sendInstagramMessage(senderId, messages[type]);
    } catch (err) {
      console.error("[Followup] Send failed:", err.message);
    }
  }, delay);
  pendingFollowups.set(senderId, { timer, type });
  console.log(`[Followup] Set "${type}" timer for ${senderId} (${delay / 60000} min)`);
}

function cancelFollowup(senderId) {
  const existing = pendingFollowups.get(senderId);
  if (existing) {
    clearTimeout(existing.timer);
    pendingFollowups.delete(senderId);
    console.log(`[Followup] Cancelled for ${senderId}`);
  }
}

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

// ─── Lucky Fit MCP: real-time court reservations ─────────
const COURT_CATALOG = [
  { num: 1, name: "#1 Land Rover Padel Court", offpeak: 1200, peak: 1400 },
  { num: 2, name: "#2 Guzema Padel Court",     offpeak: 1200, peak: 1400 },
  { num: 3, name: "#3 Smakota Padel Court",    offpeak: 1100, peak: 1300 },
  { num: 4, name: "#4 Varenycia Padel Court",  offpeak: 1100, peak: 1300 },
  { num: 5, name: "#5 Shyna365 Padel Court",   offpeak: 1100, peak: 1300 },
  { num: 6, name: "#6 Padel Blue",             offpeak: 1100, peak: 1300 },
  { num: 7, name: "#7 Intergal Bud Padel Court", offpeak: 1200, peak: 1400 },
  { num: 8, name: "#8 Padel Purple",           offpeak: 1200, peak: 1400 },
  { num: 9, name: "#9 Padel Purple",           offpeak: 1200, peak: 1400 },
  { num: 0, name: "iSolar Padel Court 1x1",    offpeak: 800,  peak: 1100 },
];

function matchCourtNum(itemName) {
  const m = itemName.match(/^#(\d+)/);
  if (m) return parseInt(m[1]);
  if (/isolar|1[xх]1/i.test(itemName)) return 0;
  return -1;
}

async function mcpQuery(sql) {
  const id = ++mcpReqId;
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(LUCKYFIT_MCP_URL, {
      method: "POST",
      headers: { "Api-Key": LUCKYFIT_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "run_query", arguments: { sql, limit: 500 } },
        id,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(tm);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "MCP RPC error");
    const text = json.result?.content?.[0]?.text;
    if (!text) throw new Error("Empty MCP response");
    const parsed = JSON.parse(text);
    return parsed.rows || [];
  } catch (err) {
    clearTimeout(tm);
    throw err;
  }
}

function calcBookingSlots(startHour, amount, courtCfg, isWeekend) {
  if (isWeekend) return Math.round((amount / courtCfg.peak) * 2);
  if (startHour >= 17) return Math.round((amount / courtCfg.peak) * 2);
  const offpeakAvail = 17 - startHour;
  const maxOffpeakCost = offpeakAvail * courtCfg.offpeak;
  if (amount <= maxOffpeakCost + 50) return Math.round((amount / courtCfg.offpeak) * 2);
  const peakHours = (amount - offpeakAvail * courtCfg.offpeak) / courtCfg.peak;
  return Math.round((offpeakAvail + peakHours) * 2);
}

async function checkCourtAvailabilityMCP(date, durationMin = 60) {
  const rows = await mcpQuery(
    `SELECT date, item, amount FROM v_client_reserves_object ` +
    `WHERE date >= '${date}' AND date < DATE_ADD('${date}', INTERVAL 1 DAY) ` +
    `AND is_cancelled = 0 ORDER BY item, date`
  );
  console.log(`[MCP] Got ${rows.length} court bookings for ${date}`);

  const d = new Date(date + "T12:00:00");
  const weekend = d.getDay() === 0 || d.getDay() === 6;

  const SLOTS = [];
  for (let h = 7; h < 23; h++) {
    SLOTS.push(`${String(h).padStart(2, "0")}:00`);
    SLOTS.push(`${String(h).padStart(2, "0")}:30`);
  }

  const now = new Date();
  const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
  const todayStr = kyivNow.toISOString().slice(0, 10);
  const isToday = date === todayStr;
  const minStartMins = isToday
    ? (kyivNow.getMinutes() > 0 ? (kyivNow.getHours() + 1) * 60 : kyivNow.getHours() * 60)
    : 7 * 60;

  if (isToday) console.log(`[MCP] Today filter: skip slots before ${Math.floor(minStartMins / 60)}:${String(minStartMins % 60).padStart(2, "0")}`);

  const summary = COURT_CATALOG.map(court => {
    const avail = new Array(SLOTS.length).fill(true);
    const courtRows = rows.filter(r => matchCourtNum(r.item) === court.num);

    for (const bk of courtRows) {
      const utc = new Date(bk.date);
      const kyiv = new Date(utc.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
      const sH = kyiv.getHours(), sM = kyiv.getMinutes();
      const label = `${String(sH).padStart(2, "0")}:${String(sM).padStart(2, "0")}`;
      let idx = SLOTS.indexOf(label);
      if (idx === -1) {
        const mins = sH * 60 + sM;
        idx = SLOTS.findIndex(s => { const [h, m] = s.split(":").map(Number); return h * 60 + m >= mins; });
      }
      if (idx === -1) continue;
      const numSlots = calcBookingSlots(sH + sM / 60, parseFloat(bk.amount), court, weekend);
      for (let i = 0; i < numSlots && idx + i < avail.length; i++) avail[idx + i] = false;
    }

    const blocks = [];
    let bStart = null, bPrice = null;
    for (let i = 0; i < SLOTS.length; i++) {
      const [h] = SLOTS[i].split(":").map(Number);
      const slotMins = h * 60 + parseInt(SLOTS[i].split(":")[1]);
      if (isToday && slotMins < minStartMins) continue;
      const price = weekend ? court.peak : (h >= 17 ? court.peak : court.offpeak);
      if (avail[i]) {
        if (bStart === null) { bStart = SLOTS[i]; bPrice = price; }
        else if (price !== bPrice) { blocks.push({ from: bStart, to: SLOTS[i], price: bPrice }); bStart = SLOTS[i]; bPrice = price; }
      } else {
        if (bStart !== null) { blocks.push({ from: bStart, to: SLOTS[i], price: bPrice }); bStart = null; }
      }
    }
    if (bStart !== null) blocks.push({ from: bStart, to: "23:00", price: bPrice });

    const minDur = Math.max(durationMin, 60);
    const validBlocks = blocks
      .map(b => {
        const [fH, fM] = b.from.split(":").map(Number);
        const [tH, tM] = b.to.split(":").map(Number);
        return { ...b, durationMinutes: (tH * 60 + tM) - (fH * 60 + fM) };
      })
      .filter(b => b.durationMinutes >= minDur);

    return {
      court: court.name,
      availableBlocks: validBlocks.length > 0 ? validBlocks : `Немає вільних блоків на ${minDur}+ хвилин`,
    };
  });

  return { error: false, date, courts: summary };
}

async function checkCourtAvailabilityAdmin(date, durationMin = 60) {
  const ctrlAvail = new AbortController();
  const tmAvail = setTimeout(() => ctrlAvail.abort(), 15000);
  const res = await fetch(`${RAILWAY_API}?date=${date}`, { signal: ctrlAvail.signal });
  clearTimeout(tmAvail);
  if (!res.ok) throw new Error(`Admin API ${res.status}`);
  const data = await res.json();

  const now = new Date();
  const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
  const todayStr = kyivNow.toISOString().slice(0, 10);
  const isToday = data.date === todayStr;
  const currentHour = kyivNow.getHours();
  const currentMin = kyivNow.getMinutes();
  const minStartTime = currentMin > 0
    ? `${String(currentHour + 1).padStart(2, "0")}:00`
    : `${String(currentHour).padStart(2, "0")}:00`;

  const summary = (data.courts || []).map(court => {
    const blocks = [];
    let blockStart = null, blockPrice = null;
    for (const slot of court.slots) {
      if (isToday && slot.start < minStartTime) continue;
      if (slot.available) {
        if (!blockStart) { blockStart = slot.start; blockPrice = slot.price; }
        else if (slot.price !== blockPrice) { blocks.push({ from: blockStart, to: slot.start, price: blockPrice }); blockStart = slot.start; blockPrice = slot.price; }
      } else {
        if (blockStart) { blocks.push({ from: blockStart, to: slot.start, price: blockPrice }); blockStart = null; }
      }
    }
    if (blockStart && court.slots.length > 0) blocks.push({ from: blockStart, to: court.operatingHours.end, price: blockPrice });

    const minDur = Math.max(durationMin, 60);
    const validBlocks = blocks
      .map(b => { const [fH, fM] = b.from.split(":").map(Number); const [tH, tM] = b.to.split(":").map(Number); return { ...b, durationMinutes: (tH * 60 + tM) - (fH * 60 + fM) }; })
      .filter(b => b.durationMinutes >= minDur);

    return { court: court.courtName, availableBlocks: validBlocks.length > 0 ? validBlocks : `Немає вільних блоків на ${minDur}+ хвилин` };
  });

  return { error: false, date: data.date, courts: summary };
}

async function checkCourtAvailability(date, durationMin = 60) {
  try {
    return await checkCourtAvailabilityAdmin(date, durationMin);
  } catch (err) {
    console.error(`[Availability] Admin API failed: ${err.message}`);
    return { error: true, text: "Не вдалося перевірити доступність. Спробуйте пізніше або зателефонуйте +380 (77) 732 00 00" };
  }
}

function mergeAvailability(admin, mcp, date, durationMin) {
  const d = new Date(date + "T12:00:00");
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  const SLOTS = [];
  for (let h = 7; h < 23; h++) {
    SLOTS.push(`${String(h).padStart(2, "0")}:00`);
    SLOTS.push(`${String(h).padStart(2, "0")}:30`);
  }

  // Build per-court booked sets from admin blocks
  const merged = admin.courts.map(adminCourt => {
    const adminBooked = new Set();
    if (Array.isArray(adminCourt.availableBlocks)) {
      // Admin gives available blocks — everything else is booked
      const freeSlots = new Set();
      for (const blk of adminCourt.availableBlocks) {
        const [fH, fM] = blk.from.split(":").map(Number);
        const [tH, tM] = blk.to.split(":").map(Number);
        const startMins = fH * 60 + fM;
        const endMins = tH * 60 + tM;
        for (const s of SLOTS) {
          const [h, m] = s.split(":").map(Number);
          const mins = h * 60 + m;
          if (mins >= startMins && mins < endMins) freeSlots.add(s);
        }
      }
      for (const s of SLOTS) {
        if (!freeSlots.has(s)) adminBooked.add(s);
      }
    } else {
      // No available blocks = all booked
      for (const s of SLOTS) adminBooked.add(s);
    }

    // Find matching MCP court and add its booked slots
    const courtNum = matchCourtNum(adminCourt.court);
    const mcpCourt = mcp.courts.find(c => {
      const cat = COURT_CATALOG.find(cc => cc.name === c.court);
      return cat && cat.num === courtNum;
    });
    const mcpBooked = new Set();
    if (mcpCourt && Array.isArray(mcpCourt.availableBlocks)) {
      const mcpFree = new Set();
      for (const blk of mcpCourt.availableBlocks) {
        const [fH, fM] = blk.from.split(":").map(Number);
        const [tH, tM] = blk.to.split(":").map(Number);
        const startMins = fH * 60 + fM;
        const endMins = tH * 60 + tM;
        for (const s of SLOTS) {
          const [h, m] = s.split(":").map(Number);
          const mins = h * 60 + m;
          if (mins >= startMins && mins < endMins) mcpFree.add(s);
        }
      }
      for (const s of SLOTS) {
        if (!mcpFree.has(s)) mcpBooked.add(s);
      }
    }

    // Union: booked if EITHER says booked
    const allBooked = new Set([...adminBooked, ...mcpBooked]);
    const extra = [...mcpBooked].filter(s => !adminBooked.has(s));
    if (extra.length > 0) console.log(`[Merge] ${adminCourt.court}: MCP added ${extra.length} extra booked slots`);

    // Rebuild available blocks from merged data
    const blocks = [];
    let bStart = null, bPrice = null;
    for (const s of SLOTS) {
      const [h] = s.split(":").map(Number);
      const cat = COURT_CATALOG.find(c => c.num === courtNum) || { offpeak: 1200, peak: 1400 };
      const price = weekend ? cat.peak : (h >= 17 ? cat.peak : cat.offpeak);
      if (!allBooked.has(s)) {
        if (bStart === null) { bStart = s; bPrice = price; }
        else if (price !== bPrice) { blocks.push({ from: bStart, to: s, price: bPrice }); bStart = s; bPrice = price; }
      } else {
        if (bStart !== null) { blocks.push({ from: bStart, to: s, price: bPrice }); bStart = null; }
      }
    }
    if (bStart !== null) blocks.push({ from: bStart, to: "23:00", price: bPrice });

    const minDur = Math.max(durationMin, 60);
    const validBlocks = blocks
      .map(b => {
        const [fH, fM] = b.from.split(":").map(Number);
        const [tH, tM] = b.to.split(":").map(Number);
        return { ...b, durationMinutes: (tH * 60 + tM) - (fH * 60 + fM) };
      })
      .filter(b => b.durationMinutes >= minDur);

    return {
      court: adminCourt.court,
      availableBlocks: validBlocks.length > 0 ? validBlocks : `Немає вільних блоків на ${minDur}+ хвилин`,
    };
  });

  return { error: false, date, courts: merged };
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

⛔ АБСОЛЮТНА ЗАБОРОНА: слова «на жаль», «нажаль» ЗАБОРОНЕНІ. Якщо ти збираєшся написати «на жаль» — ВИДАЛИ це слово і перефразуй речення. Ніколи, ні в якому контексті.

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
12. НІКОЛИ не використовуй «на жаль», «нажаль», «на жаль,» — ЗАБОРОНЕНО! Ми не вибачаємось, ми просто інформуємо. Замість «На жаль, ми можемо бронювати лише на 60/90/120 хвилин» → «Ми бронюємо на 60, 90 або 120 хвилин 😊»
13. ⛔ ЗАБОРОНА MARKDOWN: Це Instagram DM, НЕ веб-сторінка! НІКОЛИ не пиши:
   - [текст](url) — ЗАБОРОНЕНО! Пиши ТІЛЬКИ саме посилання: t.me/levpadel
   - НЕ дублюй посилання в дужках: «t.me/levpadel (https://t.me/levpadel)» — ЗАБОРОНЕНО! Тільки: t.me/levpadel
   - ### заголовки — ЗАБОРОНЕНО! Замість ### Преміум корти: → 💎 Преміум корти:
   - **жирний** або *курсив* — ЗАБОРОНЕНО! Пиши звичайним текстом
   - Назви кортів БЕЗ зірочок: Land Rover Padel Court 1 (НЕ *Land Rover Padel Court 1*)
   Якщо хочеш дати посилання — пиши ОДНЕ посилання без дужок, без дублювання
15. НОМЕР КОРТУ: Коли клієнт каже «5 корт», «корт 3», «можна 7» — це НОМЕР корту, НЕ порядковий номер у списку! «5 корт» = Shyna365 Court 5, «3 корт» = Smakota Court 3, «7 корт» = Intergal Bud Court 7, «1 корт» = Land Rover Court 1. ЗАВЖДИ перевіряй номер корту в назві!
17. КОНТАКТИ АДМІНА: Коли направляєш клієнта до адміністратора — ЗАВЖДИ давай ОБИДВА контакти: Telegram: t.me/levpadel І телефон: +380 (77) 732 00 00. НІКОЛИ не давай тільки Telegram без телефону!
18. ТЕНІС: У нас НЕМАЄ тенісних кортів. Тенісні корти були перероблені в падел-корти. LEV Padel — це виключно падел-клуб. Якщо клієнт запитує про теніс — поясни що тенісних кортів немає, але запроси спробувати падел! Падел — це дуже схоже на теніс, але ще цікавіше. Запропонуй забронювати падел-корт 💚🎾

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

## ІНВЕНТАР

⚠️ ВАЖЛИВО — ракетки та м'ячі при ТРЕНУВАННІ З ТРЕНЕРОМ вже ВХОДЯТЬ у вартість тренування! НЕ кажи клієнту що вони оплачуються окремо, якщо він записується на тренування!

При ОРЕНДІ КОРТУ (без тренера) — ракетки та м'ячі оплачуються ОКРЕМО на рецепції:
- 🟢 Аматорська ракетка — 100 грн/год (легка, ідеальна для початківців)
- 🔵 Професійна ракетка — 150 грн/год (для досвідчених)
- 🟣 Преміум ракетка — 250 грн/год (топові бренди)
- М'ячі — 50 грн/тубус
- В клубі є магазин з ракетками, кросівками, формою, аксесуарами
- НЕ питай про інвентар під час бронювання! Згадуй тільки після підтвердження оплати або коли клієнт сам питає

## ТРЕНУВАННЯ

⚠️ ГОЛОВНЕ ПРАВИЛО: бот НЕ бронює тренерів і НЕ приймає оплату за тренерів!
Тренера підбирає ТІЛЬКИ адміністратор.
Якщо клієнт хоче ЗАПИСАТИСЬ на тренування — НЕ розповідай про формати/ціни, одразу збирай контакти (прізвище, ім'я, телефон) і передавай адміну.
Якщо клієнт ПИТАЄ про тренерів/формати/ціни як інформацію — тоді покажи список нижче.
НЕ рекомендуй конкретного тренера для рівня клієнта. НІКОЛИ не рахуй вартість тренера в загальну суму бронювання!

4 формати (ціна за тренера, корт оплачується ОКРЕМО, ракетки та м'ячі ВХОДЯТЬ у вартість тренування):
🔹 Індивідуальне — ви і тренер 1 на 1. Максимум уваги до техніки, персональна програма. Можна на будь-якому корті, включаючи одиночний.
🔹 Спліт — тренування вдвох з тренером (2 учні + тренер). Можна відпрацьовувати парну гру. Ціна ділиться на двох. ТІЛЬКИ стандартний корт 2×2 (одиночний НЕ підходить — тренер бере участь у грі)!
🔹 Ігрове — тренер грає з вами як партнер/суперник. Акцент на тактиці та реальних ігрових ситуаціях
🔹 Спліт +1/2 — група 3-4 особи з тренером. Найдоступніший формат. ТІЛЬКИ стандартний корт 2×2.

⚠️ ОДИНОЧНИЙ КОРТ І ТРЕНЕР: одиночний корт підходить ТІЛЬКИ для індивідуального тренування (1 учень + тренер). Для спліту, ігрового та спліт +1/2 — тільки стандартний корт 2×2, бо тренер бере участь у грі і на одиночному це незручно. Якщо клієнт хоче спліт на одиночному — поясни що для спліту використовується стандартний корт 2×2.

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
- Ракетки та м'ячі при оренді корту — оплата на місці (НЕ входять у передоплату). При тренуванні з тренером — ракетки та м'ячі вже ВХОДЯТЬ у вартість!

⚠️ ВАЖЛИВО — коли клієнт ПИТАЄ «можна оплатити в клубі?», «готівкою можна?», «на місці заплатити?» — це ПИТАННЯ, НЕ підтвердження оплати!
Відповідай: «Якщо це ваш перший візит — у порядку виключення можна оплатити готівкою в клубі на рецепції 😊 На місці ви поповните свій депозит, і наступні бронювання можна буде сплачувати з нього — це дуже зручно! 💚»
Після цього — ЧЕКАЙ відповідь клієнта. НЕ підтверджуй бронювання!
Якщо клієнт НЕ вперше — готівка неможлива: «Оплата лише через передоплату або з вашого депозиту в клубі 😊»

⚠️ «Рахунок оплачується через платіжний сервіс, зміни заборонені» — якщо клієнт надсилає скріншот з таким повідомленням або каже що не може оплатити з депозиту:
Це означає, що раніше було ініційовано оплату карткою (клієнтом або адміністратором). Система 15 хвилин очікує на платіж і блокує інші способи оплати, щоб не сталася подвійна оплата.
Відповідай: «Це означає, що було ініційовано оплату карткою 😊 Система очікує платіж протягом 15 хвилин. Зачекайте 15 хвилин — після цього зможете обрати інший спосіб оплати, наприклад з депозиту. Якщо питання залишиться — зверніться до адміністратора в Telegram: t.me/levpadel або зателефонуйте: +380 (77) 732 00 00 💚»

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

⚠️ Коли клієнт питає «можна через програму оплатити?» / «через додаток можна?» / «можна в додатку?»:
Відповідай: «Ви маєте на увазі наш мобільний додаток Lev Padel? Так, ви можете забронювати корт і оплатити прямо в додатку 😊
📲 iPhone: https://bit.ly/4y59EVw
📲 Android: https://bit.ly/4zMFqZg»

## ВІДПОВІДЬ НА ЗАПИТ ЦІН

Коли клієнт питає скільки коштує / яка вартість / прайс:
У нас 10 кортів 🎾
📋 Ціни за годину:
Стандартні — 1100 грн (офпік) / 1300 грн (пік)
Преміум — 1200 грн (офпік) / 1400 грн (пік)
Одиночний (1×1) — 800 грн (офпік) / 1100 грн (пік)
⏰ Офпік: Пн-Пт до 17:00
⏰ Пік: Пн-Пт з 17:00 + Сб-Нд весь день
Оренда ракетки — від 100 грн/год, м'ячики — 50 грн (при тренуванні з тренером ракетки та м'ячі входять у вартість!)
На який день хочете забронювати? 😊

## СЦЕНАРІЙ: БРОНЮВАННЯ КОРТУ

⚠️ НЕ показуй доступність поки не знаєш дату І тривалість! Питай КРОК ЗА КРОКОМ:

Крок 1: Запитай дату — «На яку дату вас цікавить?» (якщо клієнт не вказав)
Крок 2: Запитай тривалість — «На скільки часу: 60, 90 чи 120 хвилин?» (якщо клієнт не вказав)
Крок 3: ТІЛЬКИ ТЕПЕР виклич check_court_availability(date) → покажи корти, де є вільний блок потрібної тривалості.

Правила показу:
- Функція повертає JSON з полями: from (найраніший час початку), latestStart (найпізніший час початку), pricePerHour, totalPrice.
- ⚠️⚠️ КРИТИЧНО: Клієнт може ПОЧИНАТИ гру ТІЛЬКИ від "from" до "latestStart"! Наприклад, якщо from=07:00, latestStart=10:00, тривалість=120хв → клієнт може почати о 07:00, 07:30, 08:00... до 10:00. О 10:30 або пізніше — НЕ МОЖНА! НІКОЛИ не пропонуй час пізніше ніж latestStart!
- Використовуй totalPrice з відповіді — не рахуй самостійно!
- Якщо availableStartTimes = "немає вільних слотів" — корт зайнятий, НЕ показуй його!
- Клуб працює до 23:00 — показуй слоти до 23:00
- ⚠️ ПОКАЗУЙ ВСІ ДОСТУПНІ КОРТИ! Не обирай один — клієнт сам вирішить! Згрупуй по типу (преміум/стандарт/одиночний) і покажи КОЖЕН корт де є потрібний блок. Наприклад якщо 5 преміум кортів вільні — покажи всі 5, а не один!
- Формат показу для кожного блоку: "[from]–[latestStart] (ціна: [totalPrice] грн)". Наприклад: "07:00–10:00 (ціна: 2400 грн)"
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

⚠️⚠️ КРИТИЧНЕ ПРАВИЛО: Якщо в запиті клієнта є БУДЬ-ЯКА згадка тренера/тренування — НЕ ВИКЛИКАЙ check_court_availability! НЕ показуй вільні корти! НЕ пропонуй часи! Навіть якщо клієнт ТАКОЖ хоче погратись без тренера — ВСЕ передається адміну через create_lead! Тренер сам підбере корт, час і все інше. Бот збирає ТІЛЬКИ: прізвище, ім'я, телефон.

Клієнт хоче записатись на тренування / займатись з тренером / питає про вільних тренерів:
⚠️ НЕ розповідай про формати і ціни, НЕ пояснюй правила гри! Одразу збирай контакти:
1. «Будь ласка, залиште прізвище, ім'я та контактний номер телефону. Адміністратор зв'яжеться з вами і підбере тренування та зручний час 😊»
2. Щойно клієнт надав ім'я і телефон → ОБОВ'ЯЗКОВО ОДРАЗУ виклич create_lead! Параметри:
   - name: прізвище + ім'я клієнта
   - phone: номер телефону
   - instagram: нік клієнта в Instagram
   - notes: "Instagram DM | Хоче тренування з тренером. Дата: [дата якщо вказав]. Час: [час якщо вказав]. Додатково: [все що клієнт просив — наприклад також погратись без тренера, кількість людей тощо]. Зв'язатись!"
3. Після успішного create_lead відповідай: «Заявку зафіксовано! Адміністратор зв'яжеться найближчим часом і підбере тренера, корт та зручний час 😊» → СТОП
⚠️ НЕ чекай додаткових питань — отримав ім'я і телефон = ОДРАЗУ create_lead!
НЕ пропонуй бронювати корт, НЕ показуй доступні слоти, НЕ рахуй загальну вартість!
Якщо клієнт хоче І тренера І погратись без тренера — все одно ТІЛЬКИ збирай контакти! Все в notes, адмін розбереться.

Клієнт питає про тренерів / формати / ціни тренувань (інформаційне питання):
- Покажи 4 формати з короткими описами та діапазон цін
- Покажи тренерів з цінами (інфо з секції ТРЕНУВАННЯ вище)
- Якщо після цього хоче записатись → збери прізвище, ім'я, телефон, дату → create_lead → адмін

## СЦЕНАРІЙ: БОНУС 500 ГРН НА ДЕПОЗИТ — АКЦІЯ СКАСОВАНА!

⚠️ Акція з бонусом 500 грн на депозит за реєстрацію в додатку БІЛЬШЕ НЕ ДІАЄ!
НЕ обіцяй нарахування 500 грн на депозит! НЕ кажи що акція скасована!
Якщо клієнт питає про бонус 500 грн, скріншоти реєстрації, або умови цієї акції — просто направ до адміністратора:

Відповідай: «Будь ласка, для уточнення зв'яжіться з адміністратором 😊
📲 Telegram: t.me/levpadel
📞 Телефон: +380 (77) 732 00 00»

НЕ створюй лід, НЕ збирай контакти для цього сценарію — просто контакти адміна.

## СЦЕНАРІЙ: ЗНИЖКА ЗА ЗІБРАНУ ГРУ (Matchmaking бот)

У Telegram є бот @levpadel_match_bot (LevPadel Matchmaking), який збирає гравців на гру (до 4 гравців). Якщо людина зібрала повну гру до 16:00 — їй надходить сповіщення зі знижкою.

Коли клієнт пише: «я зібрала/зібрав гру через бота», «у мене знижка від бота», «зібрав гру і хочу знижку»:

1. Спитай дату і тривалість (як у звичайному бронюванні)
2. Покажи доступні корти
3. Коли клієнт обирає корт — збери прізвище, ім'я, номер телефону
4. ОБОВ'ЯЗКОВО попроси: «Будь ласка, надішліть скріншот сповіщення про знижку від бота 😊»
5. Коли клієнт надсилає скріншот — переглянь його (ти бачиш зображення!)
6. НЕ скидай реквізити для оплати! Знижка потребує підрахунку адміністратором
7. Створи заявку через create_lead з notes = "Instagram DM | Зібрав гру в Matchmaking боті, має знижку. Корт: [назва], дата: [дата], час: [час], тривалість: [хв]. Скріншот знижки надіслав."
8. Надішли клієнту: «Дякуємо! Передаю адміністратору для уточнення знижки та резерву корту 😊 З вами зв'яжуться найближчим часом! 💚»

Якщо клієнт каже що сповіщення не було / не може знайти — направи до адміна: «Зверніться до адміністратора в Telegram: t.me/levpadel або зателефонуйте: +380 (77) 732 00 00 — вони допоможуть з підтвердженням знижки 😊»

⚠️ Бот НІКОЛИ не рахує знижку сам! Тільки передає адміну.

## СЦЕНАРІЙ: ГРУПОВІ ЗАНЯТТЯ

Постійних груп НЕ існує. Групи формуються за запитом через Telegram.
Запропонуй: Telegram-канал https://t.me/+-j5dqQtZJcozYjUy або залишити контакти.

## ЩО БРАТИ З СОБОЮ

Зручний спортивний одяг і кросівки — все, що потрібно! 🎾
Ракетку та м'ячі можна орендувати (від 100 грн/год). При тренуванні з тренером ракетки та м'ячі вже включені!
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
Скажи: «Зверніться, будь ласка, до адміністратора в Telegram: t.me/levpadel або зателефонуйте: +380 (77) 732 00 00. Вони допоможуть вирішити цю ситуацію 😊»

## КРИТИЧНІ ПРАВИЛА

1. create_lead — СТРОГО ОДИН РАЗ за діалог. Завжди передавай instagram нік клієнта
2. Без прізвища, імені та телефону — НЕ створюй лід. Репост/реакція без тексту — просто привітайся
3. Після фінального повідомлення — СТОП
4. Якщо create_lead повернув помилку — скажи що заявка зафіксована, адмін обробить
5. Якщо клієнт питає «куди платити» — продублюй реквізити
6. НІКОЛИ не включай вартість тренера в суму бронювання корту! Тренер = тільки адмін
7. При ОРЕНДІ КОРТУ — ракетки/м'ячі окремо на рецепції. При ТРЕНУВАННІ З ТРЕНЕРОМ — ракетки та м'ячі ВХОДЯТЬ у вартість тренування!
8. Сума бронювання = ТІЛЬКИ вартість корту × тривалість. Нічого більше!
9. ⚠️ Якщо клієнт хоче ТРЕНЕРА — НІКОЛИ не викликай check_court_availability! Не показуй корти, не пропонуй часи! ТІЛЬКИ збирай ім'я + телефон → create_lead. Тренер сам підбере корт і час. Навіть якщо клієнт також хоче погратись без тренера — все в одну заявку, адмін розбереться!`;

// OpenAI function definitions for the bot
const OPENAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "check_court_availability",
      description: "Перевірити доступність кортів LEV Padel на конкретну дату. Повертає вільні слоти з цінами. ОБОВ'ЯЗКОВО передавай duration — без нього функція покаже всі блоки, навіть занадто короткі!",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Дата у форматі YYYY-MM-DD, наприклад 2026-08-30",
          },
          duration: {
            type: "number",
            description: "Тривалість бронювання в хвилинах: 60, 90 або 120. Функція поверне ТІЛЬКИ корти з блоком достатньої тривалості.",
          },
        },
        required: ["date", "duration"],
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "system", content: `Сьогодні: ${new Date().toLocaleDateString("uk-UA", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Europe/Kyiv" })}. Поточний час: ${new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" })}.\n\n${BOT_SYSTEM_PROMPT}` }, ...messages],
        tools: OPENAI_TOOLS,
        tool_choice: "auto",
        temperature: 0.7,
        max_tokens: 1200,
      }),
    });
    clearTimeout(timeout);

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
          const dur = args.duration || 60;
          console.log(`[Bot] Checking availability for ${args.date}, duration ${dur} min`);
          const avail = await checkCourtAvailability(args.date, dur);
          if (avail.error) {
            result = avail.text;
          } else {
            const enriched = avail.courts.map(court => {
              const courtNum = matchCourtNum(court.court);
              const cfg = COURT_CATALOG.find(c => c.num === courtNum);
              const type = cfg ? (cfg.num === 0 ? "одиночний" : (cfg.offpeak >= 1200 ? "преміум" : "стандарт")) : "";
              if (!Array.isArray(court.availableBlocks)) {
                return { court: court.court, type, availableStartTimes: "немає вільних слотів" };
              }
              return {
                court: court.court,
                type,
                availableStartTimes: court.availableBlocks.map(blk => {
                  const [tH, tM] = blk.to.split(":").map(Number);
                  const latestMins = (tH * 60 + tM) - dur;
                  const latestStart = `${String(Math.floor(latestMins / 60)).padStart(2, "0")}:${String(latestMins % 60).padStart(2, "0")}`;
                  const totalPrice = Math.round(blk.price * (dur / 60));
                  return { from: blk.from, latestStart, pricePerHour: blk.price, totalPrice };
                }),
              };
            });
            result = JSON.stringify({ date: avail.date, requestedDuration: dur, courts: enriched }, null, 2);
            console.log(`[Bot] Availability result for GPT:\n${result.slice(0, 2000)}`);
          }
          if (!avail.error) setFollowup(senderId, "court_shown");
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
                // Set follow-up: if client doesn't confirm payment → remind
                setFollowup(senderId, "payment_pending");
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

  // Keep last 40 messages for context window (covers full-day conversations)
  if (conv.messages.length > 40) {
    conv.messages = conv.messages.slice(-40);
  }

  try {
    // Deep copy messages for OpenAI call (tool_calls are added in-place)
    const msgCopy = JSON.parse(JSON.stringify(conv.messages));
    const response = await callOpenAI(msgCopy, senderId);
    conv.messages.push({ role: "assistant", content: response });

    // ── Safety net: GPT promised to create lead but didn't call create_lead ──
    // Only triggers when bot says "заявку зафіксовано" or "передам заявку" (past tense / done),
    // NOT when bot says "зв'яжеться найближчим часом" (future promise while still asking for contacts)
    if (!leadCreated.get(senderId) && response) {
      const promisePatterns = /заявк[уі].{0,10}зафіксован|зафіксован.{0,10}заявк|передам.{0,15}заявк|заявк.{0,10}створен|передав.{0,15}адміністратор|зараз передам/i;
      if (promisePatterns.test(response)) {
        // Search last 6 user messages for phone number
        const recentUserMsgs = conv.messages
          .filter(m => m.role === "user")
          .slice(-6)
          .map(m => typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.filter(c => c.type === "text").map(c => c.text).join(" ") : ""))
          .join("\n");

        // Exclude bot placeholder texts from name search
        const cleanedMsgs = recentUserMsgs
          .replace(/\[Клієнт надіслав:?\s*\w*\]/gi, "")
          .replace(/\[image\]/gi, "");

        const phoneMatch = cleanedMsgs.match(/(\+?3?8?0\d{9}|\b0\d{9}\b|\b0\d{2}\s?\d{3}\s?\d{2}\s?\d{2}\b)/);
        if (phoneMatch) {
          const phone = phoneMatch[1].replace(/\s/g, "");
          // Try to extract name: must be 2-4 Capitalized Cyrillic words (real name pattern)
          const lines = cleanedMsgs.split("\n").filter(l => l.trim());
          let name = "";

          // First: look for name on the same line as the phone
          for (const line of lines) {
            if (line.match(/(\+?3?8?0\d{9}|0\d{9})/)) {
              const nameFromLine = line.replace(/(\+?3?8?0\d{9}|0\d{9})/g, "").replace(/[^\p{L}\s'-]/gu, "").trim();
              // Name must be 2-4 capitalized words, each starting with uppercase
              if (nameFromLine.match(/^[\p{Lu}][\p{Ll}'ʼ-]+(\s+[\p{Lu}][\p{Ll}'ʼ-]+){1,3}$/u)) {
                name = nameFromLine;
                break;
              }
            }
          }

          // Second: look for a standalone line that is clearly a name (2-3 Capitalized words, short)
          if (!name) {
            for (const line of [...lines].reverse()) {
              const cleaned = line.replace(/[^\p{L}\s'ʼ-]/gu, "").trim();
              if (cleaned.match(/^[\p{Lu}][\p{Ll}'ʼ-]+(\s+[\p{Lu}][\p{Ll}'ʼ-]+){1,2}$/u) && cleaned.length >= 5 && cleaned.length < 40) {
                name = cleaned;
                break;
              }
            }
          }

          if (name && phone) {
            console.warn(`[SafetyNet] GPT promised lead but didn't call create_lead! Auto-creating: ${name}, ${phone}`);
            leadCreated.set(senderId, true);
            const leadResult = await createLeadInCRM({
              name,
              phone,
              instagram: "",
              notes: "Instagram DM | AUTO-SAFETY-NET: GPT обіцяв передати заявку, але не викликав create_lead. Перевірте деталі в DM.",
            });
            if (leadResult.success) {
              console.log(`[SafetyNet] Lead created successfully for ${name}`);
              setFollowup(senderId, "payment_pending");
            } else {
              console.error(`[SafetyNet] Lead creation failed: ${leadResult.error}`);
            }
          } else {
            console.log(`[SafetyNet] GPT promised lead but name not found (strict validation). Phone="${phone}". Skipping auto-create.`);
          }
        }
      }
    }

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

// ─── Sanitize bot response (strip markdown, banned words) ─

function sanitizeBotResponse(text) {
  let clean = text;

  // 1. Remove markdown links: [text](url) → text
  clean = clean.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1");

  // 2. Remove duplicate links in parentheses: t.me/levpadel (https://t.me/levpadel) → t.me/levpadel
  clean = clean.replace(/(\S+)\s*\(https?:\/\/\S+\)/g, "$1");

  // 3. Remove markdown headers: ### Title → Title
  clean = clean.replace(/^#{1,6}\s+/gm, "");

  // 4. Remove bold/italic markdown: **text** → text, *text* → text
  clean = clean.replace(/\*\*([^*]+)\*\*/g, "$1");
  clean = clean.replace(/\*([^*]+)\*/g, "$1");

  // 5. Remove "на жаль" in all forms
  clean = clean.replace(/[Нн]а жаль,?\s*/gi, "");
  clean = clean.replace(/[Нн]ажаль,?\s*/gi, "");

  // 6. Clean up double spaces and leading spaces on lines
  clean = clean.replace(/  +/g, " ");
  clean = clean.replace(/^ +/gm, "");

  // 7. Fix sentences that start with lowercase after removal (e.g. "На жаль, ми..." → "Ми...")
  clean = clean.replace(/^([a-zа-яіїєґ])/gm, (match) => match.toUpperCase());

  return clean.trim();
}

// ─── Instagram Messaging API ─────────────────────────────

async function sendInstagramMessage(recipientId, text) {
  if (!INSTAGRAM_ACCESS_TOKEN) {
    console.error("[Instagram] No access token configured");
    return;
  }

  // Sanitize: strip markdown, banned words before sending
  text = sanitizeBotResponse(text);

  // Anti-duplicate at SEND level: skip if same text was sent to same recipient recently
  const textKey = text.substring(0, 100);
  const lastSent = recentSentMessages.get(recipientId);
  if (lastSent && lastSent.text === textKey && (Date.now() - lastSent.time < SEND_DEDUP_TTL)) {
    console.log(`[Instagram] ⛔ Duplicate send blocked for ${recipientId} (same text ${Math.round((Date.now() - lastSent.time) / 1000)}s ago)`);
    return;
  }
  recentSentMessages.set(recipientId, { text: textKey, time: Date.now() });
  setTimeout(() => recentSentMessages.delete(recipientId), SEND_DEDUP_TTL);

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
        // Track message_id for echo detection (PRIMARY — 100% reliable)
        const sentMsgId = data.message_id;
        if (sentMsgId) {
          botSentMessageIds.add(sentMsgId);
          // Auto-clean after 5 min
          setTimeout(() => botSentMessageIds.delete(sentMsgId), 300000);
        }
        // Also track text as fallback (for echoes without matching message_id)
        let sentList = botSentTexts.get(recipientId);
        if (!sentList) {
          sentList = [];
          botSentTexts.set(recipientId, sentList);
        }
        sentList.push({ text: chunks[i].trim().substring(0, 100), time: Date.now() });
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
        if (Date.now() - SERVER_START_TIME < ECHO_GRACE_PERIOD) {
          console.log(`[Echo] Skipped during grace period`);
          continue;
        }

        const echoRecipient = event.recipient?.id;
        const echoText = (event.message?.text || "").trim().substring(0, 100);
        const echoMid = event.message?.mid;

        if (echoRecipient && (echoText || echoMid)) {
          let isBotEcho = false;
          if (echoMid && botSentMessageIds.has(echoMid)) {
            botSentMessageIds.delete(echoMid);
            isBotEcho = true;
          }

          if (!isBotEcho && echoText) {
            const sentList = botSentTexts.get(echoRecipient);
            const matchIdx = sentList
              ? sentList.findIndex(e => echoText === e.text)
              : -1;
            if (matchIdx !== -1) {
              sentList.splice(matchIdx, 1);
              if (sentList.length === 0) botSentTexts.delete(echoRecipient);
              isBotEcho = true;
            }
          }

          if (isBotEcho) {
            console.log(`[Echo] Bot echo for ${echoRecipient}`);
          } else {
            if (echoText && echoText.toLowerCase().startsWith("/bot")) {
              humanTakeover.delete(echoRecipient);
              console.log(`[Takeover] 🔓 Admin sent /bot → bot RESUMED for ${echoRecipient}`);
            } else {
              humanTakeover.set(echoRecipient, Date.now());
              cancelFollowup(echoRecipient);
              console.log(`[Takeover] ✅ Admin replied to ${echoRecipient}, bot paused for 2 hours`);
            }
          }
        }
        continue;
      }

      const senderId = event.sender?.id;
      if (!senderId) continue;

      // ── Message ID dedup: Instagram sends story mentions as 2+ events ──
      const messageId = event.message?.mid;
      if (messageId) {
        if (processedMessageIds.has(messageId)) {
          console.log(`[Webhook] Duplicate mid ${messageId} from ${senderId}, skipping`);
          continue;
        }
        processedMessageIds.add(messageId);
        setTimeout(() => processedMessageIds.delete(messageId), MESSAGE_ID_TTL);
      }

      // Learn the bot's webhook IGSID from recipient field of incoming messages
      if (event.recipient?.id) BOT_IDS.add(event.recipient.id);

      // Skip messages from the bot itself (multiple ID formats possible)
      if (BOT_IDS.has(senderId)) continue;

      // ── Cancel any pending follow-up (client responded!) ──
      cancelFollowup(senderId);

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

      // ── Share/mention detection FIRST (before text check) ──
      // Instagram sends story mentions as 2+ events — catch ALL duplicates
      const isStoryMention = event.message?.attachments?.some(a =>
        ["share", "story_mention", "reel", "ig_reel", "media_share"].includes(a.type)
      ) || (event.referral?.type === "STORY_MENTION");

      if (isStoryMention) {
        const lastShare = lastShareResponse.get(senderId);
        if (lastShare && (Date.now() - lastShare < SHARE_RESPONSE_COOLDOWN)) {
          console.log(`[Webhook] Duplicate share/mention from ${senderId}, skipping (${Math.round((Date.now() - lastShare) / 1000)}s ago)`);
          continue;
        }
        lastShareResponse.set(senderId, Date.now());
        // МОВЧИМО — не відповідаємо, діалог залишається непрочитаним для SMM/адміна (репост)
        console.log(`[Webhook] Story mention/share from ${senderId} — no reply (keeping unread for SMM)`);
        continue;
      }

      // ── Suppress text event that follows a story mention (same Instagram event split into 2) ──
      const recentShare = lastShareResponse.get(senderId);
      if (recentShare && (Date.now() - recentShare < 10000)) {
        console.log(`[Webhook] Suppressing post-mention text from ${senderId} (${Math.round((Date.now() - recentShare) / 1000)}s after mention)`);
        continue;
      }

      // ── Emoji реакції та чисті emoji — МОВЧИМО ЗАВЖДИ ──
      // На реакції в переписці (сердечко на наше повідомлення) — мовчимо
      // На чисті emoji-повідомлення в чаті — мовчимо
      // Ніяких 💚 чи інших відповідей — бот реагує ТІЛЬКИ на текст
      const rawText = event.message?.text || "";
      const isReaction = event.reaction != null;
      // Digits 0-9, #, * are in \p{Emoji} but are NOT real emoji — exclude them
      const hasOnlyDigitsOrPunctuation = /^[\d\s:.,#*+\-()]+$/.test(rawText.trim());
      const isPureEmoji = rawText.length > 0 && rawText.length <= 8
        && !hasOnlyDigitsOrPunctuation
        && /^[\p{Emoji}\p{Emoji_Component}‍️\s]+$/u.test(rawText);
      if (isReaction || isPureEmoji) {
        console.log(`[Webhook] Emoji reaction/message from ${senderId}: "${rawText || event.reaction?.emoji}" — ignoring (no response)`);
        continue;
      }

      // ── Regular message handling (only if not already handled as share) ──
      if (!messageText) {
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
            messageText = event.message.text || "";
          }
          // Other unknown attachment types
          else {
            messageText = `[Клієнт надіслав: ${types.join(", ")}]`;
          }
        } else if (event.postback) {
          messageText = event.postback.payload || event.postback.title || "[кнопка]";
        } else {
          continue;
        }
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
          console.error("[Bot] Fatal error:", err.message);
          try {
            await sendInstagramMessage(
              senderId,
              "Вибачте, сталася технічна помилка 😊 Я не можу переглянути інформацію зараз. Будь ласка, зв'яжіться з адміністратором у Telegram: t.me/levpadel або за телефоном: +380 (77) 732 00 00"
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
      duration: z
        .number()
        .optional()
        .describe("Тривалість бронювання в хвилинах (60, 90, 120). За замовчуванням 60."),
    },
    async ({ date, duration }) => {
      const result = await checkCourtAvailability(date, duration || 60);
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
