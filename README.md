# Crusonia

GTM engine (a Clay/Apollo alternative run by AI agents). Cloudflare Worker (Hono) + Neon Postgres, with the dashboard
(React SPA in `web/`) served from the same Worker as static assets.
Agents (your own Grok Bot, Claude Code, Cursor or Codex) work through our MCP server at `/mcp`; AgentMail handles
email (opted-in leads only); Apify supplies web and lead data (our MCP tools call its REST API); HubSpot and Notion are synced; Clerk handles users; Stripe bills hosted usage
in credits.

Live: https://crusonia.dev · MCP: https://crusonia.dev/mcp


i made this for a hackathon, it currently sucks. 11/8/26
