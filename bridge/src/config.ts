// Bridge configuration from the environment. Values are validated, never logged.
import { z } from "zod";
import { isE164 } from "./phone.ts";

const Schema = z
  .object({
    // "live" holds the Spectrum connection; "mock" runs everything against an in-memory iMessage (local dev, tests).
    SPECTRUM_MODE: z.enum(["live", "mock"]).default("live"),
    SPECTRUM_PROJECT_ID: z.string().trim().optional(),
    SPECTRUM_PROJECT_SECRET: z.string().trim().optional(),
    // The only number this bridge ever texts, and the only sender whose messages it acts on.
    OWNER_PHONE: z.string().trim().refine(isE164, "OWNER_PHONE must be E.164, e.g. +14155550123"),
    // Optional extra handles of the owner (comma list), e.g. an Apple ID email if their iPhone sends from it.
    OWNER_ALIASES: z.string().trim().optional(),
    // Shared with the Worker (BRIDGE_SECRET there too). At least 32 characters: `openssl rand -hex 32`.
    BRIDGE_SECRET: z.string().trim().min(32, "BRIDGE_SECRET must be at least 32 characters"),
    // The Worker's public URL (wrangler.jsonc PUBLIC_URL); inbound commands go to <WORKER_URL>/webhooks/photon.
    WORKER_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
    // How often to ask the Worker for notices (the Worker can ask for slower polls while iMessage is off).
    POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(5_000),
    // Local health/operator server. Bound to loopback by default: the bridge accepts no traffic from outside.
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    HEALTH_HOST: z.string().trim().default("127.0.0.1"),
    // Shown in /api/status (e.g. the git commit the box runs).
    BRIDGE_VERSION: z.string().trim().max(40).default("dev"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .superRefine((v, ctx) => {
    if (v.SPECTRUM_MODE === "live" && (!v.SPECTRUM_PROJECT_ID || !v.SPECTRUM_PROJECT_SECRET)) {
      ctx.addIssue({ code: "custom", message: "SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET are required in live mode" });
    }
  });

export type Config = {
  mode: "live" | "mock";
  projectId?: string;
  projectSecret?: string;
  ownerPhone: string;
  ownerHandles: string[];
  bridgeSecret: string;
  workerUrl: string;
  pollIntervalMs: number;
  port: number;
  healthHost: string;
  version: string;
  logLevel: "debug" | "info" | "warn" | "error";
};

/** Throws one readable error naming every bad variable (names only, never values). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`);
    throw new Error(`Invalid bridge configuration:\n  ${problems.join("\n  ")}`);
  }
  const v = parsed.data;
  const aliases = (v.OWNER_ALIASES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    mode: v.SPECTRUM_MODE,
    projectId: v.SPECTRUM_PROJECT_ID,
    projectSecret: v.SPECTRUM_PROJECT_SECRET,
    ownerPhone: v.OWNER_PHONE,
    ownerHandles: [v.OWNER_PHONE, ...aliases],
    bridgeSecret: v.BRIDGE_SECRET,
    workerUrl: v.WORKER_URL,
    pollIntervalMs: v.POLL_INTERVAL_MS,
    port: v.PORT,
    healthHost: v.HEALTH_HOST,
    version: v.BRIDGE_VERSION,
    logLevel: v.LOG_LEVEL,
  };
}
