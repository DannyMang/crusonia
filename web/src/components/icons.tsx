// Icons exported from the Paper designs (stroke icons on an 18px or 16px grid). `currentColor` lets the
// parent set the color; the designs use ink at 78% for idle nav items and full ink when active.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (size: number): P => ({
  width: size,
  height: size,
  viewBox: `0 0 ${size} ${size}`,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  style: { flexShrink: 0, display: "inline-block" },
});

export function Logo({ size = 32, ...p }: P & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 180 180" aria-hidden style={{ flexShrink: 0, display: "inline-block" }} {...p}>
      <path d="M90.0 87.7 L145.4 87.7 L132.3 65.0 L103.1 65.0 L116.1 42.4 L90.0 42.4 L76.9 65.0 Z" fill="#200D0D" />
      <path d="M88.0 91.2 L60.3 43.2 L47.2 65.8 L61.9 91.2 L35.7 91.2 L48.8 113.8 L74.9 113.8 Z" fill="#200D0D" />
      <path d="M92.0 91.2 L64.3 139.1 L90.5 139.1 L105.1 113.8 L118.1 136.4 L131.2 113.8 L118.1 91.2 Z" fill="#200D0D" />
    </svg>
  );
}

export const HomeIcon = (p: P) => (
  <svg {...base(18)} {...p}>
    <path d="M2.25 6.75L9 1.5l6.75 5.25V15a1.5 1.5 0 01-1.5 1.5H3.75a1.5 1.5 0 01-1.5-1.5V6.75z" />
    <path d="M6.75 16.5V9h4.5v7.5" />
  </svg>
);

export const LeadsIcon = (p: P) => (
  <svg {...base(18)} {...p}>
    <circle cx="7" cy="6" r="2.75" />
    <path d="M1.75 15.25c0-2.7 2.35-4.5 5.25-4.5s5.25 1.8 5.25 4.5" />
    <path d="M12 3.4a2.7 2.7 0 010 5.2M13.6 10.9c1.65.6 2.65 2.1 2.65 4.35" />
  </svg>
);

export const ApprovalsIcon = (p: P) => (
  <svg {...base(18)} {...p}>
    <circle cx="9" cy="9" r="7" />
    <path d="M6 9.25l2.1 2.1L12.25 7" />
  </svg>
);

export const WorkflowsIcon = (p: P) => (
  <svg {...base(18)} {...p}>
    <rect x="1.75" y="2.25" width="5.5" height="4.5" rx="1.2" />
    <rect x="10.75" y="11.25" width="5.5" height="4.5" rx="1.2" />
    <path d="M4.5 6.75v3.5a3 3 0 003 3h3.25" />
  </svg>
);

export const RepliesIcon = (p: P) => (
  <svg {...base(18)} {...p}>
    <path d="M15.75 8.4a6.4 6.4 0 01-9.3 5.7L2.25 15.5l1.4-3.9A6.4 6.4 0 1115.75 8.4z" />
  </svg>
);

export const IntegrationsIcon = (p: P) => (
  <svg {...base(18)} {...p}>
    <path d="M6.5 1.75v3.5M11.5 1.75v3.5" />
    <path d="M4.25 5.25h9.5v2.75a4.75 4.75 0 01-9.5 0V5.25z" />
    <path d="M9 12.75v3.5" />
  </svg>
);

export const TerminalIcon = (p: P) => (
  <svg {...base(18)} {...p}>
    <rect x="2.25" y="3.75" width="13.5" height="11.25" rx="2" />
    <path d="M5.25 7.5l2.25 2.25-2.25 2.25M9 12h3.75" />
  </svg>
);

export const SettingsIcon = (p: P) => (
  <svg {...base(18)} {...p}>
    <circle cx="9" cy="9" r="2.25" />
    <path d="M14.7 11.1a1.2 1.2 0 00.24 1.32l.04.04a1.45 1.45 0 11-2.06 2.06l-.04-.04a1.2 1.2 0 00-1.32-.24 1.2 1.2 0 00-.73 1.1v.12a1.45 1.45 0 11-2.9 0v-.06a1.2 1.2 0 00-.79-1.1 1.2 1.2 0 00-1.32.24l-.04.04a1.45 1.45 0 11-2.06-2.06l.04-.04a1.2 1.2 0 00.24-1.32 1.2 1.2 0 00-1.1-.73h-.12a1.45 1.45 0 110-2.9h.06a1.2 1.2 0 001.1-.79 1.2 1.2 0 00-.24-1.32l-.04-.04a1.45 1.45 0 112.06-2.06l.04.04a1.2 1.2 0 001.32.24h.06a1.2 1.2 0 00.73-1.1v-.12a1.45 1.45 0 112.9 0v.06a1.2 1.2 0 00.73 1.1 1.2 1.2 0 001.32-.24l.04-.04a1.45 1.45 0 112.06 2.06l-.04.04a1.2 1.2 0 00-.24 1.32v.06a1.2 1.2 0 001.1.73h.12a1.45 1.45 0 110 2.9h-.06a1.2 1.2 0 00-1.1.73z" />
  </svg>
);

export const SearchIcon = (p: P) => (
  <svg {...base(16)} {...p}>
    <circle cx="7" cy="7" r="5" />
    <path d="M11 11l3.5 3.5" />
  </svg>
);

export const ChevronUpDown = (p: P) => (
  <svg {...base(14)} strokeWidth={1.2} {...p}>
    <path d="M4.5 5.5L7 3l2.5 2.5M4.5 8.5L7 11l2.5-2.5" />
  </svg>
);

export const ChevronRight = (p: P) => (
  <svg {...base(14)} strokeWidth={1.4} {...p}>
    <path d="M5.5 3.5L9 7l-3.5 3.5" />
  </svg>
);

export const ChevronDown = (p: P) => (
  <svg {...base(14)} strokeWidth={1.4} {...p}>
    <path d="M3.5 5.5L7 9l3.5-3.5" />
  </svg>
);

export const ArrowRight = (p: P) => (
  <svg {...base(16)} strokeWidth={1.6} {...p}>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </svg>
);

export const ArrowLeft = (p: P) => (
  <svg {...base(16)} strokeWidth={1.4} {...p}>
    <path d="M13 8H3M7 4L3 8l4 4" />
  </svg>
);

export const SendIcon = (p: P) => (
  <svg {...base(16)} {...p}>
    <path d="M14.5 1.5L7 9M14.5 1.5l-4.75 13-2.75-5.5-5.5-2.75 13-4.75z" />
  </svg>
);

export const CopyIcon = (p: P) => (
  <svg {...base(14)} strokeWidth={1.2} {...p}>
    <rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1.5" />
    <path d="M9.5 4.5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v5.5a1 1 0 001 1h1.5" />
  </svg>
);

export const CheckIcon = (p: P) => (
  <svg {...base(14)} strokeWidth={1.6} {...p}>
    <path d="M3 7.5l2.5 2.5L11 4.5" />
  </svg>
);

export const PlusIcon = (p: P) => (
  <svg {...base(14)} strokeWidth={1.6} {...p}>
    <path d="M7 2.5v9M2.5 7h9" />
  </svg>
);

export const FilterIcon = (p: P) => (
  <svg {...base(14)} strokeWidth={1.3} {...p}>
    <path d="M2 3.5h10M4 7h6M5.75 10.5h2.5" />
  </svg>
);

export const LinkIcon = (p: P) => (
  <svg {...base(12)} strokeWidth={1.1} {...p}>
    <path d="M5 7a2.5 2.5 0 003.54 0l1.77-1.77a2.5 2.5 0 00-3.54-3.54L6.2 2.26" />
    <path d="M7 5a2.5 2.5 0 00-3.54 0L1.69 6.77a2.5 2.5 0 003.54 3.54l.56-.57" />
  </svg>
);

export const UploadIcon = (p: P) => (
  <svg {...base(16)} {...p}>
    <path d="M8 10.5V2.5M4.75 5.5L8 2.25l3.25 3.25M2.5 10.5v2a1.5 1.5 0 001.5 1.5h8a1.5 1.5 0 001.5-1.5v-2" />
  </svg>
);

export const ClockIcon = (p: P) => (
  <svg {...base(14)} strokeWidth={1.2} {...p}>
    <circle cx="7" cy="7" r="5.5" />
    <path d="M7 4v3l2 1.25" />
  </svg>
);

export const InfoIcon = (p: P) => (
  <svg {...base(16)} {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v3.5M8 5.25v.01" />
  </svg>
);

export const PencilIcon = (p: P) => (
  <svg {...base(12)} strokeWidth={1.1} {...p}>
    <path d="M8.5 1.75l1.75 1.75L4 9.75 1.75 10.25 2.25 8 8.5 1.75z" />
  </svg>
);

export const XIcon = (p: P) => (
  <svg {...base(12)} strokeWidth={1.4} {...p}>
    <path d="M3 3l6 6M9 3L3 9" />
  </svg>
);

export const LockIcon = (p: P) => (
  <svg {...base(12)} strokeWidth={1.1} {...p}>
    <rect x="2.25" y="5.25" width="7.5" height="5.25" rx="1" />
    <path d="M4 5.25V3.75a2 2 0 014 0v1.5" />
  </svg>
);

/** Small spinner ring used for "researching", "drafting", running states. */
export function Spinner({ size = 10, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 rounded-full border-[1.5px] border-current border-t-transparent [animation:crusonia-spin_0.9s_linear_infinite] ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
