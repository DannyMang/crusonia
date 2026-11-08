// Public landing page at "/" (Paper: naive > "Landing · v2 (blossom hero + white sections)").
// S1 hero (oil-painted field, the tree blossoms once, the painting fades to white) under a floating nav,
// S2 infrastructure, S3 connect your agent, S4 closing CTA with a plant growing from the bottom edge.
// Owner rules: Inter only, white sections after the hero, no lime highlight behind text, and no links to pages
// that do not exist (no pricing, footer or legal links yet). Signed-in visitors go straight to /app.
import { useEffect } from "react";
import { Link, Navigate } from "react-router";
import { devBypass, useSession } from "../auth.tsx";
import { Logo } from "../components/icons.tsx";
import { ConnectAgent } from "./ConnectAgent.tsx";
import { Infrastructure } from "./Infrastructure.tsx";
import { PlayOnceVideo } from "./PlayOnceVideo.tsx";
import { SECTIONS, scrollOnClick, scrollToId } from "./sections.ts";
import { WebsiteForm } from "./WebsiteForm.tsx";

const TITLE = "Crusonia · A go-to-market team that grows on its own";

const media = (name: string) => ({
  webm: `/media/${name}.webm`,
  mp4: `/media/${name}.mp4`,
  firstFrame: `/media/${name}_start.jpg`,
  poster: `/media/${name}_poster.jpg`,
});

export default function Landing() {
  const { isLoaded, isSignedIn } = useSession();

  useEffect(() => {
    const previous = document.title;
    document.title = TITLE;
    return () => {
      document.title = previous;
    };
  }, []);

  // Arriving on /#connect-your-agent (or #how-it-works) from elsewhere: scroll once the sections exist.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) requestAnimationFrame(() => scrollToId(id));
  }, []);

  if (!devBypass && isLoaded && isSignedIn) return <Navigate to="/app" replace />;

  return (
    <div className="min-h-screen bg-white text-ink [font-synthesis:none]">
      <Nav />
      <main>
        <Hero />
        <Infrastructure />
        <ConnectAgent />
        <ClosingCta />
      </main>
    </div>
  );
}

const navLink = "text-base/5 font-medium text-ink transition-colors hover:text-[#200D0DB3]";

function Nav() {
  return (
    <header className="fixed inset-x-3 top-3 z-50 sm:inset-x-6 sm:top-5">
      <nav aria-label="Main" className="flex h-14 items-center justify-between rounded-2xl bg-white pr-2 pl-4 shadow-[0_10px_30px_#200D0D1A] sm:h-16 sm:pr-3 sm:pl-6">
        <div className="flex items-center gap-11">
          <a
            href="#top"
            aria-label="Crusonia, back to top"
            className="flex items-center gap-2.5"
            onClick={(e) => {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
            }}
          >
            <Logo size={34} className="size-7.5 sm:size-8.5" />
            <span className="text-lg/6 font-semibold sm:text-xl/6">crusonia</span>
          </a>
          <div className="hidden items-center gap-7 md:flex">
            <a href={`#${SECTIONS.howItWorks}`} onClick={scrollOnClick(SECTIONS.howItWorks)} className={navLink}>
              How it works
            </a>
            <a href={`#${SECTIONS.connect}`} onClick={scrollOnClick(SECTIONS.connect)} className={navLink}>
              Connect your agent
            </a>
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <Link
            to="/sign-in"
            className="flex h-10.5 items-center rounded-lg px-3 text-[15px]/5 font-semibold text-ink transition-colors hover:bg-[#200D0D08] sm:border sm:border-[#200D0D26] sm:px-5 sm:text-base/5"
          >
            Sign in
          </Link>
          <Link to="/sign-up" className="flex h-10.5 items-center rounded-lg bg-ink px-4 text-[15px]/5 font-bold text-white transition-colors hover:bg-[#3A2424] sm:px-5 sm:text-base/5">
            Get started
          </Link>
        </div>
      </nav>
    </header>
  );
}

// The painting fades to white at the bottom (the design's "Shade" layer).
const shade = { backgroundImage: "linear-gradient(in oklab 180deg, #FFFFFF00 0%, #FFFFFFA6 38%, #FFFFFFF2 66%, #FFFFFF 86%)" };

function Hero() {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative flex h-[clamp(640px,100svh,900px)] flex-col justify-end overflow-hidden bg-[#2E4A2A] px-5 sm:px-6">
      <PlayOnceVideo {...media("hero_bloom")} play="load" className="absolute inset-0 size-full object-cover object-[72%_50%] lg:object-center" />
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-[78%] sm:h-[520px]" style={shade} />
      <div className="relative flex flex-col items-start gap-7 pb-12 sm:px-8 sm:pb-18 lg:px-14 min-[1320px]:flex-row min-[1320px]:items-end min-[1320px]:justify-between">
        <h1 id="hero-title" className="text-balance text-[42px]/[46px] font-semibold tracking-[-1px] sm:text-[64px]/[68px] lg:text-[76px]/20 lg:tracking-[-1.6px]">
          <span className="sm:block">A go-to-market team</span> <span className="sm:block">that grows on its own.</span>
        </h1>
        <div className="flex w-full flex-col gap-3.5 pb-1.5 sm:w-auto">
          <WebsiteForm variant="hero" />
          <p className="text-[15px]/4.5 font-[525] text-[#200D0D99] sm:pl-5.5">
            No website yet?{" "}
            <Link to="/sign-up" className="underline decoration-1 [text-underline-position:from-font] hover:text-ink">
              Tell us what you're building
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section
      aria-labelledby="closing-title"
      className="flex flex-col items-center gap-10 overflow-clip border-t border-[#200D0D0F] bg-white px-5 pt-24 sm:px-10 lg:px-20 lg:pt-30"
    >
      <div className="flex flex-col items-center gap-5 text-center">
        <h2 id="closing-title" className="text-balance text-[44px]/[48px] font-semibold tracking-[-1px] sm:text-[64px]/[68px] lg:text-[80px]/21 lg:tracking-[-1.8px]">
          Grow your company offline.
        </h2>
        <p className="max-w-140 text-[18px]/[27px] font-[525] text-[#200D0D99] sm:text-xl/7.25">
          Your agent researches, drafts and follows up overnight. You wake up to replies, and nothing goes out without your yes.
        </p>
      </div>
      <div className="flex w-full flex-col items-center gap-3.5">
        <WebsiteForm variant="closing" />
        <p className="text-[15px]/4.5 font-[525] text-[#200D0D99]">
          Or{" "}
          <a
            href={`#${SECTIONS.connect}`}
            onClick={scrollOnClick(SECTIONS.connect)}
            className="underline decoration-1 [text-underline-position:from-font] hover:text-ink"
          >
            connect your agent
          </a>
        </p>
      </div>
      <PlayOnceVideo {...media("footer_plant")} play="view" className="h-90 w-60 shrink-0 object-cover sm:h-112.5 sm:w-75" />
    </section>
  );
}
