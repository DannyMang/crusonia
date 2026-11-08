// Loads config for local scripts: process.env wins, then .dev.vars (same file wrangler dev uses).
// `--env <name>` (e.g. `bun run setup --env staging`) targets a wrangler environment instead: its file is
// .dev.vars.<name> (gitignored) and its PUBLIC_URL comes from wrangler.jsonc env.<name>.vars.
// Never log values returned from here.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function envFlag(argv: string[]): string | undefined {
  const i = argv.indexOf("--env");
  const name = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith("--env="))?.slice("--env=".length);
  if (name !== undefined && !/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error("--env needs a wrangler environment name, e.g. --env staging.");
    process.exit(1);
  }
  return name;
}

/** The wrangler environment a script targets (`--env staging`), or undefined for the top-level Worker. */
export const WRANGLER_ENV = envFlag(process.argv.slice(2));
export const DEV_VARS = `${ROOT}.dev.vars${WRANGLER_ENV ? `.${WRANGLER_ENV}` : ""}`;

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[match[1]!] = value;
  }
  return out;
}

let cache: Record<string, string> | undefined;

function devVars(): Record<string, string> {
  if (!cache) cache = existsSync(DEV_VARS) ? parseDotenv(readFileSync(DEV_VARS, "utf8")) : {};
  return cache;
}

export function getVar(key: string): string | undefined {
  const value = process.env[key] || devVars()[key];
  return value ? value : undefined;
}

export function requireVar(key: string, hint = "Add it to .dev.vars (see .dev.vars.example)."): string {
  const value = getVar(key);
  if (!value) {
    console.error(`Missing ${key}. ${hint}`);
    process.exit(1);
  }
  return value;
}
