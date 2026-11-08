import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

// A deploy replaces the hashed chunks, so a tab opened before it gets a 404 for a page it has not loaded yet.
// Reload once to pick up the new build; if that already happened, App's LoadBoundary explains instead.
window.addEventListener("vite:preloadError", (event) => {
  try {
    const KEY = "crusonia.chunkReloadAt";
    if (Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < 30_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
    event.preventDefault();
    window.location.reload();
  } catch {
    // no sessionStorage: let the error reach LoadBoundary
  }
});

async function boot() {
  // Dev-only mocks (`bun run dev:mock`). The import is dead code in production builds.
  if (import.meta.env.DEV && import.meta.env.VITE_MSW === "1") {
    const { startMocks } = await import("./mocks/browser.ts");
    await startMocks();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
