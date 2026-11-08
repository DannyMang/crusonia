// Renders the Company summary (GTM.md) from lib/markdown-parse.ts. React elements only, so whatever an agent or a
// person wrote is shown as text; links open only for http(s) URLs.
import type { ReactNode } from "react";
import { cx } from "./format.ts";
import { parseMarkdown, type Inline } from "./markdown-parse.ts";

export { parseMarkdown };

function renderInline(nodes: Inline[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case "text":
        return n.v;
      case "strong":
        return (
          <strong key={k} className="font-semibold">
            {renderInline(n.c, `${k}.`)}
          </strong>
        );
      case "em":
        return <em key={k}>{renderInline(n.c, `${k}.`)}</em>;
      case "code":
        return (
          <code key={k} className="rounded bg-[#200D0D0A] px-1 py-px text-[13px]">
            {n.v}
          </code>
        );
      case "link":
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="underline decoration-[#200D0D4D] underline-offset-[3px] hover:decoration-ink">
            {renderInline(n.c, `${k}.`)}
          </a>
        );
    }
  });
}

const body = "text-sm/5.5 font-[450] text-ink";

/** The rendered document (Paper: "Settings · Company summary" > summary card). */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className={cx("flex flex-col gap-1.5 [overflow-wrap:anywhere]", className)}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h":
            return b.level === 1 ? (
              <h2 key={i} className={cx("pb-1.5 text-[22px]/7 font-semibold tracking-[-0.4px] text-ink", i > 0 && "pt-3")}>
                {renderInline(b.c)}
              </h2>
            ) : (
              <h3 key={i} className={cx("text-[15px]/5 font-semibold text-ink", i === 0 ? "" : blocks[i - 1]?.t === "h" ? "pt-2" : "pt-3")}>
                {renderInline(b.c)}
              </h3>
            );
          case "p":
            return (
              <p key={i} className={body}>
                {renderInline(b.c)}
              </p>
            );
          case "quote":
            return (
              <blockquote key={i} className={cx(body, "border-l-2 border-l-[#200D0D26] pl-3 text-muted")}>
                {renderInline(b.c)}
              </blockquote>
            );
          case "ul":
            return (
              <ul key={i} className="flex flex-col gap-1.5">
                {b.items.map((item, j) => (
                  <li key={j} className={cx(body, "flex gap-1.5")}>
                    <span aria-hidden>•</span>
                    <span className="min-w-0">{renderInline(item)}</span>
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="flex flex-col gap-1.5">
                {b.items.map((item, j) => (
                  <li key={j} className={cx(body, "flex gap-1.5")}>
                    <span aria-hidden className="tabular-nums">
                      {b.start + j}.
                    </span>
                    <span className="min-w-0">{renderInline(item)}</span>
                  </li>
                ))}
              </ol>
            );
        }
      })}
    </div>
  );
}
