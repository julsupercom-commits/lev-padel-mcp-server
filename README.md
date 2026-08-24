# Lev Padel MCP Server

MCP (Model Context Protocol) server for the Lev Padel Instagram bot.

## Tools

- **check_court_availability** — Check padel court availability for a given date
- **create_lead** — Create a booking lead in LuckyFit CRM

## Deploy to Railway

1. Connect this repo to Railway
2. Add environment variable: `LUCKYFIT_API_KEY`
3. Deploy — Railway will use the Dockerfile automatically

## MCP URL for SendPulse

After deploy, use: `https://your-app.up.railway.app/sse`
