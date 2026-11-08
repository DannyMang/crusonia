// One-line structured logs (Railway shows stdout). Never pass secrets or full phone numbers: use maskHandle.
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = "info";
let silent = false;

export function setLogLevel(level: Level) {
  threshold = level;
}

/** Tests silence the logger. */
export function setSilent(value: boolean) {
  silent = value;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (silent || ORDER[level] < ORDER[threshold]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};

/** An error's message without stack or attached request data, cut short, with phone numbers masked. */
export function describeError(err: unknown): string {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return message.replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => `${m.slice(0, 2)}***${m.slice(-2)}`).slice(0, 300);
}
