// Page scale. The owner found the app "too zoomed in", so every page except the landing, the Terms and Privacy pages and
// the sign-in / sign-up / invite screens renders at APP_ZOOM: CSS `zoom` on <html> (AppZoom in App.tsx), so dialogs, menus and toasts
// scale with the page. Phones keep 100%: smaller text would be hard to read there. Full-height layouts are
// compensated in index.css (zoom shrinks 100vh too). Media queries still see the real window width.
// Pure, so `bun test` covers it (test/zoom.test.ts).

export const APP_ZOOM = 0.8;

/** Below Tailwind's `sm`: no zoom. */
export const PHONE_QUERY = "(max-width: 639px)";

/** "/", /sign-in/*, /sign-up/*, /sso-callback and /invite/* (the same layout), /terms and /privacy keep 100%. */
const FULL_SIZE = /^\/(?:sign-in|sign-up|sso-callback|invite|terms|privacy)?(?:\/|$)/;

export function zoomFor(pathname: string, phone: boolean): number {
  return phone || FULL_SIZE.test(pathname) ? 1 : APP_ZOOM;
}
