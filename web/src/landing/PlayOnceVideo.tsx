// A decorative clip that plays once and holds its last frame (no loop). Until it plays it shows its first
// frame, so nothing jumps when playback starts. With prefers-reduced-motion, or when the browser refuses to
// autoplay (iOS Low Power Mode, data saver), it shows the finished frame as a still image instead.
// An optional `small` variant (smaller files for phones) is picked once, when the clip mounts.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(REDUCED_MOTION);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
  );
}

type Sources = {
  webm: string;
  mp4: string;
  /** First frame: shown until playback starts. */
  firstFrame: string;
  /** Last frame: the still shown instead of the clip (reduced motion, autoplay refused). */
  poster: string;
};

type Props = Sources & {
  /** Used instead when `media` (a media query) matches on mount, e.g. a smaller encode for phones. */
  small?: Sources & { media: string };
  /** "load": autoplay right away (hero). "view": start when it scrolls into view (closing plant). */
  play: "load" | "view";
  className?: string;
};

export function PlayOnceVideo({ small, play, className, ...large }: Props) {
  // Chosen once: switching <source>s later would not reload the clip anyway, and it must not restart.
  const [{ webm, mp4, firstFrame, poster }] = useState<Sources>(() => (small && window.matchMedia(small.media).matches ? small : large));
  const reduced = usePrefersReducedMotion();
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || reduced) return;
    video.muted = true; // autoplay policies check the property; React does not always reflect `muted`
    const start = () => {
      video.play().catch((err: unknown) => {
        // AbortError just means a newer load interrupted this play(); only a refusal means "no autoplay".
        if (err instanceof DOMException && err.name === "NotAllowedError") setFailed(true);
      });
    };
    if (play === "load") {
      start();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          start();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(video);
    return () => io.disconnect();
  }, [reduced, play]);

  if (reduced || failed) return <img src={poster} alt="" aria-hidden decoding="async" className={className} />;

  return (
    <video
      ref={ref}
      className={className}
      autoPlay={play === "load"}
      muted
      playsInline
      preload="auto"
      poster={firstFrame}
      aria-hidden
      tabIndex={-1}
      disablePictureInPicture
      disableRemotePlayback
    >
      <source src={webm} type='video/webm; codecs="vp9"' />
      {/* The last source failing means neither format plays here: fall back to the still. */}
      <source src={mp4} type="video/mp4" onError={() => setFailed(true)} />
    </video>
  );
}
