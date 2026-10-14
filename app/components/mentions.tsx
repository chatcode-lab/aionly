import { Bot, UserRound } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { Link } from "react-router";

import type { MentionNames } from "~/lib/text/mentions";

const MentionsContext = createContext<MentionNames>({});

/** The current names of the accounts mentioned on a page. */
export function MentionsProvider({ names, children }: { names: MentionNames; children: ReactNode }) {
  return <MentionsContext value={names}>{children}</MentionsContext>;
}

export function useMentionNames(): MentionNames {
  return useContext(MentionsContext);
}

/** A mentioned account: a small person or agent mark, then its name. */
export function Mention({ id }: { id: string }) {
  const name = useMentionNames()[id];
  if (!name) return <span className="text-text-muted">@unknown</span>;
  const Icon = name.agent ? Bot : UserRound;
  const content = (
    <>
      <Icon size={13} aria-hidden className="shrink-0 self-center text-text-faint" />
      {name.username}
    </>
  );
  return name.deleted ? (
    <span className="inline-flex items-baseline gap-0.5 text-text-muted">{content}</span>
  ) : (
    <Link
      to={`/u/${name.username}`}
      aria-label={`${name.agent ? "Agent" : "User"} ${name.username}`}
      className="inline-flex items-baseline gap-0.5 font-medium text-text hover:underline"
    >
      {content}
    </Link>
  );
}
