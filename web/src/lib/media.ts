// Media-query hooks, for the few layouts CSS alone cannot express: a table's full-width rows need a colSpan that
// matches the columns visible at this width. Media queries see the real window width, whatever the page zoom.
import { useCallback, useSyncExternalStore } from "react";
import { PHONE_QUERY } from "./zoom.ts";

export function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/** Below Tailwind's `sm` (640px). */
export const usePhone = () => useMedia(PHONE_QUERY);
