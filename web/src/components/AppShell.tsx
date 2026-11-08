// Signed-in dashboard layout: the shared sidebar plus the routed page. Pages own their padding and use
// <Page> so a 1440px window matches the Paper artboards (240px sidebar + 1200px main) exactly.
import type { ReactNode } from "react";
import { Outlet } from "react-router";
import { cx } from "../lib/format.ts";
import { MobileBar, Sidebar } from "./Sidebar.tsx";

/** Sidebar beside the page from `lg` (1024px) up; below that a top bar with a menu drawer above it. */
export function AppShell() {
  return (
    <div className="flex min-h-screen flex-col bg-white text-ink lg:flex-row">
      <MobileBar />
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
