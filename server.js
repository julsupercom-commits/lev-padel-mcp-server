import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomUUID } from "crypto";

// ─── Config ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const RAILWAY_API =
  "https://lev-padel-admin.up.railway.app/api/public/availability";
const LUCKYFIT_API = "https://my.lucky.fitness/api/leads";
const LUCKYFIT_API_KEY = process.env.LUCKYFIT_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8701730693:AAGh4jbnSQn5gRDSZ-Oc8RtY5KcgFrtKPjw";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "-5388739834";

// ─── Express app ──────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", server: "lev-padel-mcp", version: "1.0.0" });
});

// ─── MCP Server factory ──────────────────────────────────
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
      try {
        const res = await fetch(`${RAILWAY_API}?date=${date}`);
        if (!res.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Помилка API (${res.status}): не вдалося отримати дані. Спробуйте іншу дату.`,
              },
            ],
            isError: true,
          };
        }
        const data = await res.json();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Помилка з'єднання з сервером доступності: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool 2: Create lead in LuckyFit CRM
  server.tool(
    "create_lead",
    "Створити нового ліда (заявку на бронювання) в CRM LuckyFit. Викликати після того як клієнт підтвердив бронювання та надав контактні дані.",
    {
      name: z.string().describe("Ім'я клієнта"),
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
      if (!LUCKYFIT_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "Помилка: API ключ LuckyFit не налаштований. Зверніться до адміністратора.",
            },
          ],
          isError: true,
        };
      }

      try {
        const baseBody = {
          name,
          ...(phone && { phone }),
          ...(notes && { notes }),
          platform: "instagram",
        };

        const headers = {
          "Content-Type": "application/json",
          "Api-Key": LUCKYFIT_API_KEY,
        };

        // Instagram info_source_id = 8284 in LuckyFit CRM
        const body = { ...baseBody, info_source_id: 8284 };

        const res = await fetch(LUCKYFIT_API, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        const data = await res.json();

        if (data.success === false || !data) {
          // CRM failed — still notify Telegram so admin sees the request
          const errMsg = data?.error || "невідома помилка";
          try {
            let tgText = `🎾 <b>Нове звернення з Instagram!</b>\n\n`;
            tgText += `👤 Клієнт: ${name}\n`;
            if (phone) tgText += `📱 Телефон: ${phone}\n`;
            if (instagram) tgText += `📸 Instagram: @${instagram}\n`;
            if (notes) tgText += `\n📝 ${notes}\n`;
            tgText += `\n⚠️ CRM помилка: ${errMsg}\n⚡ Потребує уваги адміністратора — створіть лід вручну!`;

            await fetch(
              `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: tgText, parse_mode: "HTML" }),
              }
            );
          } catch (tgErr) {
            console.error("[Telegram] Fallback failed:", tgErr.message);
          }

          return {
            content: [
              {
                type: "text",
                text: `Помилка CRM, але адміністратор отримав сповіщення і обробить заявку. Передай клієнта адміністратору.`,
              },
            ],
            isError: true,
          };
        }

        // Send Telegram notification automatically
        try {
          let tgText = `🎾 <b>Нове звернення з Instagram!</b>\n\n`;
          tgText += `👤 Клієнт: ${name}\n`;
          if (phone) tgText += `📱 Телефон: ${phone}\n`;
          if (instagram) tgText += `📸 Instagram: @${instagram}\n`;
          if (notes) tgText += `\n📝 ${notes}\n`;
          tgText += `\n⚡ Потребує уваги адміністратора.`;

          await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: tgText,
                parse_mode: "HTML",
              }),
            }
          );
          console.log("[Telegram] Auto-notification sent for lead");
        } catch (tgErr) {
          console.error("[Telegram] Failed to send notification:", tgErr.message);
        }

        return {
          content: [
            {
              type: "text",
              text: `Лід успішно створено в CRM! Заявка зафіксована. Адміністратор отримав сповіщення в Telegram.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Помилка з'єднання з CRM: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
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

  // New session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  // Store session for reuse
  if (transport.sessionId) {
    httpSessions.set(transport.sessionId, { transport, server });
  }
});

// Handle GET for SSE stream (Streamable HTTP spec)
app.get("/sse", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && httpSessions.has(sessionId)) {
    const { transport } = httpSessions.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }

  // Fallback: legacy SSE transport
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

// Handle DELETE for session cleanup
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

// Legacy SSE message endpoint
app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId;
  const sseSessions = app.locals.sseSessions || {};
  const transport = sseSessions[sessionId];

  if (!transport) {
    return res.status(404).json({ error: "Session not found" });
  }

  await transport.handlePostMessage(req, res);
});

// ─── Debug: find info_source IDs ──────────────────────────
app.get("/debug/info-sources", async (_req, res) => {
  const headers = { "Api-Key": LUCKYFIT_API_KEY, "Content-Type": "application/json" };
  const results = [];

  // Try common API endpoints for info sources
  for (const path of ["/api/info_sources", "/api/settings/info_sources", "/api/fitness_info_sources", "/api/lead_sources"]) {
    try {
      const r = await fetch(`https://my.lucky.fitness${path}`, { headers });
      const d = await r.json();
      results.push({ path, status: r.status, data: d });
    } catch (e) {
      results.push({ path, error: e.message });
    }
  }

  // Also probe which info_source_ids are valid by checking foreign key
  const validIds = [];
  for (let id = 1; id <= 30; id++) {
    try {
      // Use a dry-run approach: send minimal data that will fail on OTHER validation (no phone)
      // but won't fail on info_source if ID is valid
      const r = await fetch("https://my.lucky.fitness/api/leads", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: `_probe_${id}`, info_source_id: id }),
      });
      const d = await r.json();
      const err = d.error || "";
      if (err.includes("foreign key") || err.includes("Info source")) {
        // ID doesn't exist
      } else {
        validIds.push({ id, error: err || "VALID (other validation)" });
      }
    } catch (e) {
      // ignore
    }
  }

  res.json({ endpoints: results, validInfoSourceIds: validIds });
});

// ─── Telegram notification endpoint (for SendPulse webhook) ───
app.post("/notify", async (req, res) => {
  try {
    const data = req.body || {};
    const name = data.name || data.contact_name || data.first_name || "Невідомий";
    const username = data.username || data.instagram_username || "";

    let text = `🎾 <b>Новий запит з Instagram!</b>\n\n`;
    text += `👤 Клієнт: ${name}\n`;
    if (username) text += `📱 Instagram: @${username}\n`;
    text += `\n⚡ Клієнт потребує уваги — перевірте чат у SendPulse та надішліть актуальні реквізити.`;

    const tgRes = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      }
    );

    const tgData = await tgRes.json();
    console.log("[Telegram] Notification sent:", tgData.ok);
    res.json({ ok: true, telegram: tgData.ok });
  } catch (err) {
    console.error("[Telegram] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Also support /mcp endpoint (alternative path)
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
  console.log(`✅ Lev Padel MCP server running on port ${PORT}`);
  console.log(`   Streamable HTTP: /sse (POST/GET/DELETE)`);
  console.log(`   Alternative:     /mcp (POST/GET/DELETE)`);
  console.log(`   Legacy SSE:      GET /sse + POST /message`);
  console.log(`   LuckyFit API key: ${LUCKYFIT_API_KEY ? "configured" : "⚠️ NOT SET"}`);
});
