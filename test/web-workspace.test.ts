// The current workspace on the client (web/src/lib/workspace.ts) and how the API client uses it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

function storage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

const g = globalThis as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;
let seen: Headers | null = null;

/** A fresh copy of the module, as a page load would get, with what's stored at that moment. */
const load = async () => (await import(`../web/src/lib/workspace.ts?${crypto.randomUUID()}`)) as typeof import("../web/src/lib/workspace.ts");

describe("current workspace", () => {
  beforeEach(() => {
    g.sessionStorage = storage();
    g.localStorage = storage();
  });
  afterEach(() => {
    delete g.sessionStorage;
    delete g.localStorage;
    delete g.window;
    globalThis.fetch = realFetch;
    seen = null;
  });

  test("a new tab starts from the last choice; a tab keeps its own over a choice made elsewhere", async () => {
    const first = await load();
    expect(first.currentWorkspace()).toBeNull();
    first.rememberWorkspace("ws_a");
    expect(first.currentWorkspace()).toBe("ws_a");
    // Another tab chooses B: this one stays on A.
    (g.localStorage as ReturnType<typeof storage>).setItem("crusonia.workspace", "ws_b");
    expect(first.currentWorkspace()).toBe("ws_a");
    expect((await load()).currentWorkspace()).toBe("ws_a"); // a reload of this tab: sessionStorage wins
    (g.sessionStorage as ReturnType<typeof storage>).removeItem("crusonia.workspace");
    expect((await load()).currentWorkspace()).toBe("ws_b"); // a new tab
  });

  test("forgetting goes back to the default, and blocked storage doesn't break anything", async () => {
    const w = await load();
    w.rememberWorkspace("ws_a");
    w.forgetWorkspace();
    expect(w.currentWorkspace()).toBeNull();
    expect((await load()).currentWorkspace()).toBeNull();
    const refuse = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    g.sessionStorage = refuse;
    g.localStorage = refuse;
    const blocked = await load();
    expect(blocked.currentWorkspace()).toBeNull();
    blocked.rememberWorkspace("ws_a");
    expect(blocked.currentWorkspace()).toBe("ws_a");
    blocked.forgetWorkspace();
  });

  test("the API client sends the header only once a workspace is chosen", async () => {
    const { rememberWorkspace, forgetWorkspace } = await import("../web/src/lib/workspace.ts");
    const { createApi } = await import("../web/src/api.ts");
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = new Headers(init.headers as Record<string, string>);
      return Response.json({ user: { id: "u" }, auth: "clerk" });
    }) as unknown as typeof fetch;
    const api = createApi(async () => "tok");
    forgetWorkspace();
    await api.me();
    expect(seen!.has("x-crusonia-workspace")).toBe(false);
    rememberWorkspace("ws_a");
    await api.me();
    expect(seen!.get("x-crusonia-workspace")).toBe("ws_a");
    forgetWorkspace();
  });

  test("refused as not a member: the choice is dropped and the app reloads on the default", async () => {
    const { currentWorkspace, rememberWorkspace, forgetWorkspace } = await import("../web/src/lib/workspace.ts");
    const { createApi, ApiError } = await import("../web/src/api.ts");
    const replaced: string[] = [];
    g.window = { location: { replace: (to: string) => replaced.push(to) } };
    globalThis.fetch = (async () => Response.json({ error: { code: "not_a_member", message: "no" } }, { status: 403 })) as unknown as typeof fetch;
    rememberWorkspace("ws_gone");
    await expect(createApi(async () => "tok").me()).rejects.toBeInstanceOf(ApiError);
    expect(currentWorkspace()).toBeNull();
    expect(replaced).toEqual(["/app"]);
    // Other 403s leave it alone.
    globalThis.fetch = (async () => Response.json({ error: { code: "forbidden_role", message: "no" } }, { status: 403 })) as unknown as typeof fetch;
    rememberWorkspace("ws_a");
    await expect(createApi(async () => "tok").me()).rejects.toBeInstanceOf(ApiError);
    expect(currentWorkspace()).toBe("ws_a");
    expect(replaced).toEqual(["/app"]);
    forgetWorkspace();
  });
});
