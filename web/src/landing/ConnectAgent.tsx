// S3 "Set-up fast." (Paper: Landing v2 > S3 · Connect agent): one click per agent. The buttons and the install
// commands are shared with Settings · Connect your agent (components/AgentButtons.tsx, lib/agent-install.ts).
import { AgentButtons } from "../components/AgentButtons.tsx";
import { SECTIONS } from "./sections.ts";

export function ConnectAgent() {
  return (
    <section
      id={SECTIONS.connect}
      aria-labelledby="connect-title"
      className="flex flex-col gap-10 border-t border-[#200D0D0F] bg-white px-5 pt-24 pb-28 sm:gap-12 sm:px-10 lg:px-20 lg:pt-30 lg:pb-36"
    >
      <div className="flex flex-col items-start gap-4.5">
        <h2 id="connect-title" className="text-[40px]/[46px] font-semibold tracking-[-1px] sm:text-[60px]/16.5 sm:tracking-[-1.2px]">
          Set-up fast.
        </h2>
        <p className="text-[18px]/[27px] font-[525] text-muted sm:text-[20.2px]/[29.2px]">Connect your agent in one click, then run your whole GTM from it.</p>
      </div>
      <AgentButtons className="flex flex-col gap-3.5 sm:flex-row sm:flex-wrap sm:items-center" />
    </section>
  );
}
