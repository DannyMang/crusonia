// Icons from the core feature designs (Paper: "Final · Finding leads", "Final · Research", "Final · Outreach").
// 24px grid paths drawn at the size the design uses; `currentColor` so the parent sets the color.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 14, strokeWidth = 2, children, ...p }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flexShrink: 0, display: "inline-block" }}
      {...p}
    >
      {children}
    </svg>
  );
}

export const ThumbUpIcon = (p: P) => (
  <Svg {...p}>
    <path d="M7 10v11M15 5.9L14 10h5.8a2 2 0 012 2.3l-1.4 7A2 2 0 0118.4 21H7V10l4-8a3 3 0 014 3.9z" />
  </Svg>
);

export const ThumbDownIcon = (p: P) => (
  <Svg {...p}>
    <path d="M17 14V3M9 18.1L10 14H4.2a2 2 0 01-2-2.3l1.4-7A2 2 0 015.6 3H17v11l-4 8a3 3 0 01-4-3.9z" />
  </Svg>
);

export const NoteBubbleIcon = (p: P) => (
  <Svg size={13} {...p}>
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
  </Svg>
);

export const PlusLineIcon = (p: P) => (
  <Svg size={13} {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const LinkedInIcon = (p: P) => (
  <Svg size={13} {...p}>
    <rect x="2.5" y="2.5" width="19" height="19" rx="4" />
    <path d="M7.5 10.5v6M7.5 7.5v.01M11.5 16.5v-6M11.5 13a2.5 2.5 0 015 0v3.5" />
  </Svg>
);

export const GitHubIcon = (p: P) => (
  <Svg size={13} {...p}>
    <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 00-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
  </Svg>
);

export const XBrandIcon = (p: P) => (
  <Svg size={12} strokeWidth={2.4} {...p}>
    <path d="M4 4l16 16M20 4L4 20" />
  </Svg>
);

export const GlobeIcon = (p: P) => (
  <Svg size={13} {...p}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M2.5 12h19M12 2.5c2.5 2.6 3.8 5.8 3.8 9.5s-1.3 6.9-3.8 9.5c-2.5-2.6-3.8-5.8-3.8-9.5S9.5 5.1 12 2.5z" />
  </Svg>
);

export const MailIcon = (p: P) => (
  <Svg size={14} strokeWidth={1.8} {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 7l9 6 9-6" />
  </Svg>
);

export const WarningIcon = (p: P) => (
  <Svg size={14} {...p}>
    <path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
  </Svg>
);

export const SearchLineIcon = (p: P) => (
  <Svg size={13} strokeWidth={2.2} {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Svg>
);

export const CheckLineIcon = (p: P) => (
  <Svg size={12} strokeWidth={2.4} {...p}>
    <path d="M20 6L9 17l-5-5" />
  </Svg>
);

export const CloseIcon = (p: P) => (
  <svg width={p.size ?? 12} height={p.size ?? 12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden style={{ flexShrink: 0 }} {...p}>
    <path d="M3 3l6 6M9 3l-6 6" />
  </svg>
);
