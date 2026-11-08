// Unknown paths, inside the app (/app/nope) and outside it (/nope). "Back to home" goes to the dashboard when
// signed in and to the landing page when not.
import { useEffect } from "react";
import { useSession } from "../auth.tsx";
import { ButtonLink } from "../components/ui.tsx";

export default function NotFound() {
  const { isLoaded, isSignedIn } = useSession();

  useEffect(() => {
    const previous = document.title;
    document.title = "Page not found · Crusonia";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="grid min-h-[60vh] place-items-center">
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
        <h1 className="text-[15px]/5 font-semibold tracking-[-0.01em] text-ink">Nothing here</h1>
        <p className="max-w-md text-[13px]/5 font-medium text-muted">That page does not exist.</p>
        <div className="mt-2">
          <ButtonLink to={isLoaded && isSignedIn ? "/app" : "/"}>Back to home</ButtonLink>
        </div>
      </div>
    </div>
  );
}
