// /api/keys mocks ("Dashboard · Connect your agent" > API keys), in the backend's shapes (src/api/keys.ts):
// GET {data}, POST {api_key, key} (the full key once), DELETE {api_key} (revoked, 200).
// `?mock=unconfigured` answers like a deployment where the route has not shipped yet (404 "No route for").
import { http } from "msw";
import type { ApiKey } from "../api.ts";
import { ago, body, DAY, fail, isEmpty, MIN, ok, scenario } from "./util.ts";

const active = (k: Omit<ApiKey, "revoked_at" | "status">): ApiKey => ({ ...k, revoked_at: null, status: "active" });

let keys: ApiKey[] | null = null;
const seed = (): ApiKey[] => [
  active({ id: "key_1", name: "claude-code-laptop", prefix: "crs_live_4f2a91c0", created_at: ago(5 * DAY), last_used_at: ago(1 * MIN) }),
  active({ id: "key_2", name: "cursor-acme-web", prefix: "crs_live_9c71e2b4", created_at: ago(10 * DAY), last_used_at: ago(3 * DAY) }),
  active({ id: "key_3", name: "codex-ci", prefix: "crs_live_b03e5d17", created_at: ago(18 * DAY), last_used_at: null }),
  { id: "key_0", name: "old-laptop", prefix: "crs_live_77aa0c3e", created_at: ago(40 * DAY), last_used_at: ago(26 * DAY), revoked_at: ago(25 * DAY), status: "revoked" },
];
const list = () => (keys ??= isEmpty() ? [] : seed());

const unshipped = () => scenario() === "unconfigured";
const missing = (method: string, path: string) => fail(404, "not_found", `No route for ${method} ${path}`);

export const keyHandlers = [
  http.get("/api/keys", () => (unshipped() ? missing("GET", "/api/keys") : ok({ data: list() }))),
  http.post("/api/keys", async ({ request }) => {
    if (unshipped()) return missing("POST", "/api/keys");
    const name = (await body<{ name?: string }>(request)).name?.trim();
    if (!name) return fail(400, "invalid_request", "name: Required");
    const secret = `crs_live_${crypto.randomUUID().replace(/-/g, "")}`;
    const api_key = active({ id: `key_${Date.now()}`, name, prefix: secret.slice(0, 17), created_at: new Date().toISOString(), last_used_at: null });
    list().unshift(api_key);
    return ok({ api_key, key: secret }, 201);
  }),
  http.delete("/api/keys/:id", ({ params }) => {
    if (unshipped()) return missing("DELETE", `/api/keys/${String(params.id)}`);
    const k = list().find((x) => x.id === params.id);
    if (!k) return fail(404, "not_found", `No API key with id ${String(params.id)}`);
    if (!k.revoked_at) Object.assign(k, { revoked_at: new Date().toISOString(), status: "revoked" });
    return ok({ api_key: k });
  }),
];
