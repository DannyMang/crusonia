import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";

const require = createRequire(import.meta.url);

// `bun run dev:mock` (VITE_MSW=1) mocks /api in the browser with MSW. The service worker script is served
// straight from node_modules in dev, so it is never committed or shipped in the production build.
function mswWorker(): Plugin {
  return {
    name: "crusonia:msw-worker",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/mockServiceWorker.js", (_req, res) => {
        res.setHeader("Content-Type", "text/javascript");
        res.end(readFileSync(require.resolve("msw/mockServiceWorker.js")));
      });
    },
  };
}

// The Worker (wrangler dev, :8787) serves /api, /mcp, /webhooks and /health; Vite proxies to it in dev.
const worker = process.env.CRUSONIA_API_ORIGIN ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss(), mswWorker()],
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    proxy: Object.fromEntries(["/api", "/mcp", "/webhooks", "/health"].map((p) => [p, { target: worker, changeOrigin: true }])),
    // /pricing imports the Worker's price list (src/billing/catalog.ts and plans.ts) so the two never drift.
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL("../src/billing", import.meta.url))] },
  },
  // No source maps in dist: everything in it is uploaded as a public static asset.
  build: { outDir: "dist", sourcemap: false },
});
