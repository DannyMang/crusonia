// Which workspace this tab is in. It's read once when the page loads and stays put, so a tab never starts acting on
// another workspace because you switched in a different tab. Switching is a full page load: nothing cached from the
// old workspace can show in the new one. Only a request: the API checks it against your memberships every time.
const KEY = "crusonia.workspace";

function load(): string | null {
  try {
    return sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let current = load();

export const currentWorkspace = () => current;

/** This tab now, and new tabs from now on. */
export function rememberWorkspace(id: string) {
  current = id;
  try {
    sessionStorage.setItem(KEY, id);
    localStorage.setItem(KEY, id);
  } catch {
    // Storage blocked: this tab keeps it until it reloads.
  }
}

/** Back to the default: the API picks the user's oldest workspace. */
export function forgetWorkspace() {
  current = null;
  try {
    sessionStorage.removeItem(KEY);
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

type Browser = { location: { assign(url: string): void; replace(url: string): void } };
const browser = () => (globalThis as unknown as { window?: Browser }).window;

export function openWorkspace(id: string, path = "/app") {
  rememberWorkspace(id);
  browser()?.location.assign(path);
}

/** The API says this user isn't in the chosen workspace: back to their default, without a history entry. */
export function leaveChosenWorkspace() {
  forgetWorkspace();
  browser()?.location.replace("/app");
}
