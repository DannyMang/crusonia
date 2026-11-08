// /api/keys mocks ("Dashboard · Connect your agent" > API keys). POST returns the full key once.
import { http } from "msw";
import type { ApiKey } from "../api.ts";
import { ago, body, DAY, isEmpty, MIN, noContent, ok } from "./util.ts";

let keys: ApiKey[] | null = null;
const seed = (): ApiKey[] => [
  { id: "key_1", name: "claude-code-laptop", prefix: "crs_live_4f2a", created_at: ago(5 * DAY), last_used_at: ago(1 * MIN) },
  { id: "key_2", name: "cursor-acme-web", prefix: "crs_live_9c71", created_at: ago(10 * DAY), last_used_at: ago(3 * DAY) },
  { id: "key_3", name: "codex-ci", prefix: "crs_live_b03e", created_at: ago(18 * DAY), last_used_at: null },
];
const list = () => (keys ??= isEmpty() ? [] : seed());

export const keyHandlers = [
  http.get("/api/keys", () => ok(list())),
  http.post("/api/keys", async ({ request }) => {
    const { name } = await body<{ name?: string }>(request);
    const secret = `crs_live_${crypto.randomUUID().replace(/-/g, "")}`;
    const key: ApiKey = { id: `key_${Date.now()}`, name: name || "new-key", prefix: secret.slice(0, 13), created_at: new Date().toISOString(), last_used_at: null };
    list().unshift(key);
    return ok({ ...key, key: secret }, 201);
  }),
  http.delete("/api/keys/:id", ({ params }) => {
    keys = list().filter((k) => k.id !== params.id);
    return noContent();
  }),
];
