// Which pages render at the app's 80% scale (web/src/lib/zoom.ts).
import { describe, expect, test } from "bun:test";
import { APP_ZOOM, zoomFor } from "../web/src/lib/zoom.ts";

describe("zoomFor", () => {
  test("the landing and the auth screens stay at 100%", () => {
    for (const path of ["/", "/sign-in", "/sign-in/factor-one", "/sign-up", "/sign-up/verify", "/sso-callback", "/invite/inv_abc", "/terms", "/privacy"]) expect(zoomFor(path, false)).toBe(1);
  });
  test("the app, onboarding, pricing and 404 pages use APP_ZOOM", () => {
    for (const path of ["/app", "/app/leads/lead_1", "/onboarding/1", "/pricing", "/nope", "/sign-inx", "/app/sign-in", "/app/settings/team"]) expect(zoomFor(path, false)).toBe(APP_ZOOM);
  });
  test("phones always stay at 100%", () => {
    expect(zoomFor("/app/leads", true)).toBe(1);
  });
});
