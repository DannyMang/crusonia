// Stops a deploy before it builds a web app that can't sign anyone in: Vite compiles VITE_CLERK_PUBLISHABLE_KEY into the
// bundle, so a build without it breaks sign-in for everyone on that Worker. The key may be in the environment, or in a
// web/.env file Vite reads for a build. `deploy:dry` doesn't run this: it ships nothing.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "VITE_CLERK_PUBLISHABLE_KEY";
const inFile = [".env", ".env.local", ".env.production", ".env.production.local"]
  .map((name) => fileURLToPath(new URL(`../web/${name}`, import.meta.url)))
  .some((path) => existsSync(path) && new RegExp(`^\\s*${KEY}\\s*=\\s*\\S`, "m").test(readFileSync(path, "utf8")));

if (!process.env[KEY]?.trim() && !inFile) {
  console.error(`Not deploying: ${KEY} is not set, and the web app would be built without sign-in.`);
  console.error(`Run it as: ${KEY}="$CLERK_PUBLISHABLE_KEY" bun run deploy:staging (with that key loaded in your shell), or put it in web/.env.local.`);
  process.exit(1);
}
