// Company logo marks for integrations and agents (the Crusonia logo itself is `Logo` in icons.tsx): each brand's
// official mark in its official colours, unmodified (owner, Nov 8). The files and where each one comes from (source
// URL, licence, date) are in web/src/assets/logos/LOGOS.md. Rendered as <img> so the file is drawn exactly as published: never recolour,
// redraw or stretch one (the box is square and the mark keeps its aspect ratio inside it).
import { cx } from "../lib/format.ts";

const files = import.meta.glob<string>("../assets/logos/*.{svg,png}", { eager: true, query: "?url", import: "default" });
const url = (name: BrandName) => {
  const hit = Object.entries(files).find(([path]) => path.replace(/^.*\//, "").replace(/\.(svg|png)$/, "") === name);
  return hit?.[1];
};

export const BRAND_LABEL = {
  agentmail: "AgentMail",
  apify: "Apify",
  claude: "Claude",
  clerk: "Clerk",
  codex: "Codex",
  cursor: "Cursor",
  github: "GitHub",
  google: "Google",
  hubspot: "HubSpot",
  naive: "Naive",
  notion: "Notion",
  photon: "Photon",
  stripe: "Stripe",
} as const;
export type BrandName = keyof typeof BRAND_LABEL;

/** Official files that already include clear space around the glyph: the share of the image the glyph fills. They
 *  are drawn larger by that much (the padding spills into the surrounding gap), so every glyph is `size` px. */
const GLYPH_SHARE: Partial<Record<BrandName, number>> = {
  apify: 200 / 300, // apify-symbol.svg: a 200-unit glyph in a -50 -50 300 300 viewBox
  codex: 366 / 716, // OpenAI Blossom: about 366 of 716 units; the rest is OpenAI's required clear space
};

/**
 * A brand mark in a `size` px square. Decorative by default (the brand's name sits next to it); pass `label` when
 * the mark stands alone.
 */
export function BrandLogo({ name, size = 20, label, className }: { name: BrandName; size?: number; label?: string; className?: string }) {
  const src = url(name);
  if (!src) return null;
  const box = size / (GLYPH_SHARE[name] ?? 1);
  const spill = (size - box) / 2;
  return (
    <img
      src={src}
      alt={label ?? ""}
      width={box}
      height={box}
      draggable={false}
      className={cx("max-w-none shrink-0 select-none object-contain", className)}
      style={{ width: box, height: box, ...(spill ? { margin: spill } : null) }}
    />
  );
}

/** The 28px white tile a mark sits in on setup screens (Integrations, onboarding), with clear space around it. */
export function BrandTile({ name, size = 28, mark = 18 }: { name: BrandName; size?: number; mark?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-[7px] border border-[#200D0D14] bg-white" style={{ width: size, height: size }}>
      <BrandLogo name={name} size={mark} />
    </span>
  );
}
