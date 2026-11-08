// The public price list (src/billing/catalog.ts) that both GET /api/billing and the signed-out /pricing page render.
import { describe, expect, test } from "bun:test";
import { creditFacts, leadsFor, packCatalog, planCatalog } from "../src/billing/catalog.ts";
import { FREE_PLAN, FREE_SAMPLE_CREDITS, PACKS, PLANS, TYPICAL_LEAD_CREDITS, displayPrice } from "../src/billing/plans.ts";

describe("catalog", () => {
  test("plans: Free first, then every plans.ts plan with its display price", () => {
    const plans = planCatalog();
    expect(plans.map((p) => p.key)).toEqual([FREE_PLAN.key, ...PLANS.map((p) => p.key)]);
    expect(plans[0]).toMatchObject({ kind: "free", unit_amount: 0, monthly_credits: 0, price: "$0/mo", checkout: false });
    for (const p of PLANS) {
      expect(plans.find((x) => x.key === p.key)).toEqual({
        key: p.key,
        kind: "subscription",
        name: p.name,
        description: p.description,
        unit_amount: p.unitAmount,
        interval: "month",
        monthly_credits: p.monthlyCredits,
        price: displayPrice(p),
        checkout: true,
      });
    }
  });

  test("packs mirror plans.ts", () => {
    expect(packCatalog()).toEqual(
      PACKS.map((p) => ({ key: p.key, kind: "pack", name: p.name, description: p.description, unit_amount: p.unitAmount, credits: p.credits, price: displayPrice(p) })),
    );
  });

  test("credit facts and the display-only lead estimate", () => {
    expect(creditFacts()).toEqual({ usd: 0.01, usage_markup: 2, free_sample_credits: FREE_SAMPLE_CREDITS, included_rollover_months: 1 });
    expect(creditFacts(0).free_sample_credits).toBe(0);
    expect(leadsFor(FREE_SAMPLE_CREDITS)).toBe(Math.floor(FREE_SAMPLE_CREDITS / TYPICAL_LEAD_CREDITS));
    expect(leadsFor(59)).toBe(0);
  });

  test("the catalog is plain data the web bundle can import (no runtime imports beyond plans.ts)", async () => {
    const source = await Bun.file(new URL("../src/billing/catalog.ts", import.meta.url)).text();
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["./plans.ts"]);
    const plans = await Bun.file(new URL("../src/billing/plans.ts", import.meta.url)).text();
    expect(plans).not.toMatch(/^import /m);
  });
});
