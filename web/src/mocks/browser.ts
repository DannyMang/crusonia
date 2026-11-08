// Dev-only: MSW in the browser (`bun run dev:mock`). Never imported by production builds.
import { setupWorker } from "msw/browser";
import { handlers } from "./handlers.ts";

export async function startMocks() {
  const worker = setupWorker(...handlers);
  await worker.start({ onUnhandledRequest: "bypass", quiet: true });
}
