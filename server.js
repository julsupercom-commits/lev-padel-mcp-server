import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

// ─── Config ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const RAILWAY_API =
  "https://lev-padel-admin.up.railway.app/api/public/availability";
const LUCKYFIT_API = "https://my.lucky.fitness/api/leads";
const LUCKYFIT_API_KEY = process.env.LUCKYFIT_API_KEY || "";

// ─── Express app ──────────────────────────────────────────
const app = express();
app.use(cors());

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
        .optional()
        .describe("Номер телефону клієнта, наприклад +380501234567"),
      notes: z
        .string()
        .optional()
        .describe(
          "Деталі бронювання: дата, час, номер корту, кількість гравців"
        ),
    },
    async ({ name, phone, notes }) => {
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
        const body = {
          name,
          ...(phone && { phone }),
          ...(notes && { notes }),
          platform: "instagram",
        };

        const res = await fetch(LUCKYFIT_API, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Api-Key": LUCKYFIT_API_KEY,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text();
          return {
            content: [
              {
                type: "text",
                text: `Помилка CRM (${res.status}): ${errText}`,
              },
            ],
            isError: true,
          };
        }

        const data = await res.json();
        return {
          content: [
            {
              type: "text",
              text: `Лід успішно створено в CRM. ID: ${data.id || "ok"}. Деталі: ${JSON.stringify(data)}`,
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

// ─── SSE transport ────────────────────────────────────────
const sessions = {};

app.get("/sse", async (req, res) => {
  console.log("[MCP] New SSE connection");
  const transport = new SSEServerTransport("/message", res);
  sessions[transport.sessionId] = transport;

  res.on("close", () => {
    console.log(`[MCP] SSE closed: ${transport.sessionId}`);
    delete sessions[transport.sessionId];
  });

  const server = createMcpServer();
  await server.connect(transport);
});

app.post("/message", express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sessions[sessionId];

  if (!transport) {
    return res.status(404).json({ error: "Session not found" });
  }

  await transport.handlePostMessage(req, res);
});

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Lev Padel MCP server running on port ${PORT}`);
  console.log(`   SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`   LuckyFit API key: ${LUCKYFIT_API_KEY ? "configured" : "⚠️ NOT SET"}`);
});
