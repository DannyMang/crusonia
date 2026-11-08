// S2 "Infrastructure for all your GTM needs." (Paper: Landing v2 > S2 · Infrastructure). Four columns, each a
// small static illustration of the product over a title and a line. "How it works" in the nav scrolls here.
import type { ReactNode } from "react";
import { BrandLogo, type BrandName } from "../components/BrandLogo.tsx";
import { publicLogoAllowed } from "../lib/public-logos.ts";
import { SECTIONS } from "./sections.ts";

const chip = "flex items-center rounded-full bg-lime";
const card = "rounded-lg border border-[#DCE9CF] bg-white";

function Column({ art, title, children }: { art: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-4.5">
      <div aria-hidden className="flex h-70 shrink-0 flex-col justify-center rounded-sm bg-[#F5F9F0] px-6">
        {art}
      </div>
      <h3 className="text-[21px]/6.5 font-semibold tracking-[-0.315px]">{title}</h3>
      <p className="text-[16.5px]/[24.75px] font-[525] text-muted">{children}</p>
    </div>
  );
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className={`flex items-center justify-between px-3.5 py-3 ${card}`}>
    <span className="text-[13px]/4 font-medium">{label}</span>
    {children}
  </div>
);

const workflowArt = (
  <div className="flex flex-col gap-2.5">
    <Row label="Research account">
      <span className="text-xs/4 text-green-dark">done</span>
    </Row>
    <Row label="Score fit">
      <span className="text-xs/4 text-green-dark">92</span>
    </Row>
    <Row label="Write draft">
      <span className={`h-5.5 px-2.25 text-xs/4 font-medium ${chip}`}>ready</span>
    </Row>
  </div>
);

// Sentence case with no letter-spacing (owner rule: Inter only, no caps labels), with the real brand marks where a public
// page may show them (lib/public-logos.ts) and the plain name otherwise.
const Tile = ({ logo, children }: { logo?: BrandName; children: string }) => (
  <div className={`flex h-14 min-w-0 grow basis-0 items-center justify-center gap-1.5 text-xs/4 font-medium ${card}`}>
    {logo && publicLogoAllowed(logo) ? <BrandLogo name={logo} size={16} /> : null}
    {children}
  </div>
);

const stackArt = (
  <div className="flex flex-col gap-2.5">
    <div className="flex gap-2.5">
      <Tile logo="hubspot">HubSpot</Tile>
      <Tile logo="notion">Notion</Tile>
    </div>
    <div className="flex h-14 shrink-0 items-center justify-center rounded-lg bg-lime text-xs/4 font-semibold">Crusonia agent</div>
    <div className="flex gap-2.5">
      <Tile>Inbox</Tile>
      <Tile logo="apify">Apify</Tile>
      <Tile>Web</Tile>
    </div>
  </div>
);

const Field = ({ label, value, tone }: { label: string; value: string; tone?: "green" }) => (
  <div className="flex justify-between gap-2 text-[11px]/3.5">
    <span>{label}</span>
    <span className={tone === "green" ? "text-green-dark" : "text-muted"}>{value}</span>
  </div>
);

const dataArt = (
  <div className="flex flex-col items-center gap-3.5">
    <div className={`flex w-full flex-col gap-2.5 p-4 ${card}`}>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm/4.5 font-semibold">Maya Chen</span>
        <span className="text-xs/4 font-medium text-muted">Head of Sales · Fieldnote</span>
      </div>
      <div className="h-px shrink-0 bg-[#200D0D0F]" />
      <div className="flex justify-between gap-2 text-[11px]/3.5">
        <span>maya@fieldnote.io</span>
        <span className="text-green-dark">verified</span>
      </div>
      <Field label="source" value="fieldnote.io/team" />
      <Field label="checked" value="today" />
    </div>
    <span className={`h-7 shrink-0 px-3 text-xs/4 font-medium ${chip}`}>2 duplicates merged</span>
  </div>
);

// The fourth column was "Runs experiments" in Paper; Experiments were removed from the product (owner, Nov 8), so it
// shows the approval step instead: a draft waiting for a yes, with no statistics.
const approvalArt = (
  <div className={`flex flex-col gap-3 p-4 ${card}`}>
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[13px]/4 font-semibold">Maya Chen</span>
      <span className="text-[11px]/3.5 text-muted">Code A7F2</span>
    </div>
    <span className="text-xs/4 font-medium">“Your first SDR at Fieldnote”</span>
    <div className="h-px shrink-0 bg-[#200D0D0F]" />
    <div className="flex gap-2">
      <span className={`h-7 px-3 text-xs/4 font-medium ${chip}`}>Approve &amp; send</span>
      <span className="flex h-7 items-center rounded-full border border-[#200D0D26] px-3 text-xs/4 font-medium">Edit</span>
    </div>
  </div>
);

export function Infrastructure() {
  return (
    <section id={SECTIONS.howItWorks} aria-labelledby="infra-title" className="flex flex-col gap-12 bg-white px-5 py-24 sm:px-10 lg:gap-17 lg:px-20 lg:py-32">
      <h2 id="infra-title" className="flex flex-col items-start gap-0.5 text-[40px]/[46px] font-semibold tracking-[-1px] sm:text-[60px]/16.5 sm:tracking-[-1.2px]">
        <span>Infrastructure for</span>
        <span>all your GTM needs.</span>
      </h2>
      <div className="grid grid-cols-1 gap-x-8 gap-y-12 sm:grid-cols-2 xl:grid-cols-4">
        <Column art={workflowArt} title="Builds the workflow">
          Researches each account, scores the fit and writes the draft. Every day, with no one pushing it.
        </Column>
        <Column art={stackArt} title="Connects your stack">
          HubSpot, Notion, your inbox and web data from Apify, wired together through one agent.
        </Column>
        <Column art={dataArt} title="Keeps the data clean">
          Every company and contact has a source, gets deduplicated, and is refreshed when it goes stale.
        </Column>
        <Column art={approvalArt} title="Asks before it sends">
          Every draft waits for your approval, with its sources. Nothing goes out on its own.
        </Column>
      </div>
    </section>
  );
}
