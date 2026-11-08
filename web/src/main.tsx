import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

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
