// Authors on notes and Company summary versions: the name in words and a small avatar (initials for people,
// the Crusonia mark for agents). Paper: "Final · Finding leads" popover > Notes.
import { useMemo } from "react";
import { useSession } from "../auth.tsx";
import { describeAuthor, type Author } from "../lib/authors.ts";
import { cx, initials } from "../lib/format.ts";
import { useApiKeys } from "../queries.ts";
import { Logo } from "./icons.tsx";

/** describeAuthor bound to the signed-in user and the workspace's API key names. */
export function useDescribeAuthor(): (author: string | null | undefined) => Author {
  const { user } = useSession();
  const keys = useApiKeys();
  return useMemo(() => {
    const keyNames = new Map((keys.data ?? []).map((k) => [k.id, k.name] as const));
    return (author) => describeAuthor(author, { userId: user?.id ?? null, userName: user?.name ?? null, keyNames });
  }, [keys.data, user?.id, user?.name]);
}

export function AuthorAvatar({ author, size = 22 }: { author: Author; size?: number }) {
  return (
    <span
      aria-hidden
      className={cx("flex shrink-0 items-center justify-center rounded-full", author.agent ? "bg-pill" : "bg-highlight")}
      style={{ width: size, height: size }}
    >
      {author.agent ? <Logo size={Math.round(size * 0.64)} /> : <span className="text-[9px]/3 font-semibold text-ink">{initials(author.name, "·")}</span>}
    </span>
  );
}
