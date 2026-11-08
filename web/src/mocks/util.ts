// Helpers for the dev-only MSW mocks. Sample data mirrors the Paper designs (illustration only).
import { delay, HttpResponse } from "msw";

export type Scenario = "sample" | "empty" | "unconfigured";

/** `?mock=empty|sample|unconfigured` (remembered in localStorage) picks the data set. Default: sample. */
export function scenario(): Scenario {
  try {
    const fromUrl = new URLSearchParams(location.search).get("mock");
    if (fromUrl === "empty" || fromUrl === "sample" || fromUrl === "unconfigured") localStorage.setItem("crusonia.mock", fromUrl);
    const v = localStorage.getItem("crusonia.mock");
    return v === "empty" || v === "unconfigured" ? v : "sample";
  } catch {
    return "sample";
  }
}

export const isEmpty = () => scenario() !== "sample";

export const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
export const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export async function ok<T>(body: T, status = 200) {
  await delay(120);
  return HttpResponse.json(body as never, { status });
}

export async function fail(status: number, code: string, message: string) {
  await delay(120);
  return HttpResponse.json({ error: { code, message } }, { status });
}

export const notConfigured = (key: string) => fail(503, "not_configured", `${key} is not set`);

export async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

export async function noContent() {
  await delay(120);
  return new HttpResponse(null, { status: 204 });
}
