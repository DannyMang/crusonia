// Stops a deploy before it builds a web app that can't sign anyone in: Vite compiles VITE_CLERK_PUBLISHABLE_KEY into the
// bundle, so a build without it breaks sign-in for everyone on that Worker. `deploy:dry` doesn't run this: it ships nothing.
const missing = ["VITE_CLERK_PUBLISHABLE_KEY"].filter((key) => !process.env[key]?.trim());
if (missing.length) {
  console.error(`Not deploying: ${missing.join(", ")} is not set, and the web app would be built without sign-in.`);
  console.error('Run it as: VITE_CLERK_PUBLISHABLE_KEY="$CLERK_PUBLISHABLE_KEY" bun run deploy:staging (with that key loaded in your shell).');
  process.exit(1);
}
