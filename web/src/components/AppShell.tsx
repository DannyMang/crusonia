// Signed-in dashboard layout: the shared sidebar plus the routed page. Pages own their padding and use
// <Page> so a 1440px window matches the Paper artboards (240px sidebar + 1200px main) exactly.
import type { ReactNode } from "react";
import { Outlet } from "react-router";
import { cx } from "../lib/format.ts";
import { Sidebar } from "./Sidebar.tsx";

export function AppShell() {
  return (
    <div className="flex min-h-screen bg-white text-ink">
      <Sidebar />
      <main className="flex min-w-0 grow flex-col">
        <Outlet />
      </main>
    </div>
  );
}

/** Page container: 1200px wide like the artboards' main column, centered on wider screens. */
export function Page({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("mx-auto flex w-full max-w-[1200px] min-w-0 flex-col text-xs/4", className)}>{children}</div>;
}
