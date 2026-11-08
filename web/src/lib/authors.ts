// Who wrote a note or a Company summary version, in words. Authors are stored as:
//   user:<clerk id> | user:owner (MCP_TOKEN) | user:api_key:<key id>   people (notes)
//   agent:<session id>                                                a Crusonia agent run
//   agent:api_key:<key id> | agent:mcp_token | agent:mcp             an outside agent over MCP
//   onboarding                                                        the onboarding proposal
// Pure, so `bun test` covers it.

export type AuthorContext = {
  /** The signed-in user's Clerk id and name. */
  userId: string | null;
  userName: string | null;
  /** API key id -> its name ("Claude Code"), from GET /api/keys. */
  keyNames?: ReadonlyMap<string, string>;
};

export type Author = { name: string; agent: boolean; you: boolean };

export function describeAuthor(author: string | null | undefined, ctx: AuthorContext): Author {
  const a = (author ?? "").trim();
  if (!a) return { name: "Unknown", agent: false, you: false };
  if (a === "onboarding") return { name: "Onboarding", agent: true, you: false };
  if (a.startsWith("user:api_key:")) return { name: ctx.keyNames?.get(a.slice(13)) ?? "API key", agent: false, you: false };
  if (a.startsWith("user:")) {
    const id = a.slice(5);
    // MCP_TOKEN is the owner; in local dev (no Clerk id) every person is "you".
    const you = id === "owner" || !ctx.userId || id === ctx.userId;
    return { name: you ? (ctx.userName ?? "You") : "Teammate", agent: false, you };
  }
  if (a.startsWith("agent:api_key:")) {
    const key = ctx.keyNames?.get(a.slice(14));
    return { name: key ? `${key}, over MCP` : "Your agent, over MCP", agent: true, you: false };
  }
  if (a === "agent:mcp_token" || a === "agent:mcp") return { name: "Your agent, over MCP", agent: true, you: false };
  if (a.startsWith("agent:")) return { name: "Research agent", agent: true, you: false };
  return { name: a, agent: false, you: false };
}
