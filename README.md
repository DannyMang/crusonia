# Crusonia

GTM engine (a Clay/Apollo alternative run by AI agents). Cloudflare Worker (Hono) + Neon Postgres, with the dashboard
(React SPA in `web/`) served from the same Worker as static assets.
Agents (Naive, or your own Claude Code / Cursor / Codex) work through our MCP server at `/mcp`; AgentMail handles
email (opted-in leads only); Apify supplies web and lead data (our MCP tools call its REST API, and Naive agents can
also use Apify's hosted MCP server); HubSpot and Notion are synced; Clerk handles users; Stripe bills hosted usage
in credits (see [Billing](#billing-stripe)); the owner can approve drafts by iMessage through Photon (see
[iMessage approvals](#imessage-approvals-photon)).

Live: https://crusonia.dev · MCP: https://crusonia.dev/mcp


i made this for a hackathon, it currently sucks. 11/8/26
