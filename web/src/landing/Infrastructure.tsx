// S2 "Infrastructure for all your GTM needs." (Paper: Landing v2 > S2 · Infrastructure). Four columns, each a
// small static illustration of the product over a title and a line. "How it works" in the nav scrolls here.
import type { ReactNode } from "react";
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
      <span className="text-xs/4 text-green">done</span>
    </Row>
    <Row label="Score fit">
      <span className="text-xs/4 text-green tabular-nums">92</span>
    </Row>
    <Row label="Write draft">
      <span className={`h-5.5 px-2.25 text-xs/4 font-medium ${chip}`}>ready</span>
    </Row>
  </div>
);

const Tile = ({ children }: { children: string }) => (
  <div className={`flex h-14 grow basis-0 items-center justify-center text-[11px]/3.5 font-medium ${card}`}>{children}</div>
);

const stackArt = (
  <div className="flex flex-col gap-2.5">
    <div className="flex gap-2.5">
      <Tile>HUBSPOT</Tile>
      <Tile>NOTION</Tile>
    </div>
    <div className="flex h-14 shrink-0 items-center justify-center rounded-lg bg-lime text-[11px]/3.5 font-semibold">CRUSONIA AGENT</div>
    <div className="flex gap-2.5">
      <Tile>INBOX</Tile>
      <Tile>APIFY</Tile>
      <Tile>WEB</Tile>
    </div>
  </div>
);

const Field = ({ label, value, tone }: { label: string; value: string; tone?: "green" }) => (
  <div className="flex justify-between gap-2 text-[11px]/3.5">
    <span>{label}</span>
    <span className={tone === "green" ? "text-green" : "text-muted"}>{value}</span>
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
        <span className="text-green">verified</span>
      </div>
      <Field label="source" value="fieldnote.io/team" />
      <Field label="checked" value="today" />
    </div>
    <span className={`h-7 shrink-0 px-3 text-xs/4 font-medium ${chip}`}>2 duplicates merged</span>
  </div>
);

function Bar({ label, value, width, winner }: { label: string; value: string; width: string; winner?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-[11px]/3.5">
        <span>{label}</span>
        <span className={winner ? "text-green" : undefined}>{value}</span>
      </div>
      <div className="h-2 shrink-0 rounded-full bg-[#200D0D0F]">
        <div className={`h-2 rounded-full ${winner ? "bg-green" : "bg-[#200D0D33]"}`} style={{ width }} />
      </div>
    </div>
  );
}

const experimentsArt = (
  <div className="flex flex-col gap-3">
    <div className={`flex flex-col gap-3.5 p-4 ${card}`}>
      <div className="flex justify-between">
        <span className="text-[13px]/4 font-semibold">Reply rate</span>
        <span className="text-[11px]/3.5 text-muted">40 sent each</span>
      </div>
      <Bar label="A · funding angle" value="5%" width="25%" />
      <Bar label="B · hiring angle" value="15%" width="75%" winner />
    </div>
    <div className="flex justify-center">
      <span className={`h-7 px-3 text-xs/4 font-medium ${chip}`}>scale B</span>
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
        <Column art={experimentsArt} title="Runs experiments">
          Tries a new signal or message on a small group, shows reply rate and cost, then scales what works.
        </Column>
      </div>
    </section>
  );
}
