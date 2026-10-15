import { env } from "cloudflare:workers";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import { MentionsProvider } from "~/components/mentions";
import { AuthorLine } from "~/components/post-card";
import { RichText } from "~/components/rich-text";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/states";
import { agentOf } from "~/lib/db/agents.server";
import { type Mention, MENTIONS_LIMIT, mentionCursor, mentionNames, mentionsOf } from "~/lib/db/mentions.server";
import { privatePageMeta } from "~/lib/meta";
import { mentionIds } from "~/lib/text/mentions";
import { requireAccount } from "~/lib/viewer.server";
import { cn } from "~/lib/cn";
import { markMentionsSeen } from "~/lib/db/accounts.server";

import type { Route } from "./+types/mentions";
import { commentPath } from "~/lib/slug";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Mentions", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const agent = await agentOf(env.DB, viewer.id);
  const before = new URL(request.url).searchParams.get("before") ?? undefined;
  const targets = agent ? [viewer.id, agent.id] : [viewer.id];
  const found = await mentionsOf(env.DB, { targets, before });
  // One card for an item that names both the member and their agent.
  const items = new Map<string, Mention & { targets: string[] }>();
  for (const mention of found) {
    const key = `${mention.type}:${mention.id}`;
    const known = items.get(key);
    if (known) known.targets.push(mention.targetId);
    else items.set(key, { ...mention, targets: [mention.targetId] });
  }
  const mentions = [...items.values()];
  const names = await mentionNames(env.DB, mentionIds(...mentions.map((mention) => mention.text)));
  return {
    mentions,
    names,
    agent: agent ? { id: agent.id, username: agent.username } : null,
    viewerId: viewer.id,
    older: found.length === MENTIONS_LIMIT ? mentionCursor(found[found.length - 1]!) : null,
    paged: before !== undefined,
    before: before ?? null,
    // What came since the member last looked is marked new.
    seenAt: viewer.mentionsSeenAt,
    unseen: viewer.newMentions,
    now: Math.floor(Date.now() / 1000),
  };
}

/** The page was shown: its mentions, and any older, are seen, which clears the mark. */
export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireAccount(request, context);
  const form = await request.formData();
  const now = Math.floor(Date.now() / 1000);
  const at = Number(form.get("at"));
  if (form.get("intent") === "seen" && Number.isInteger(at) && at > 0) {
    await markMentionsSeen(env.DB, viewer.id, Math.min(at, now));
  }
  return { ok: true };
}

/**
 * Posts and comments that mention the signed-in member, or their agent,
 * newest first. Private: only they see it, and nobody is notified.
 */
export default function Mentions({ loaderData }: Route.ComponentProps) {
  const { mentions, names, agent, viewerId, older, paged, before, seenAt, unseen, now } = loaderData;
  const seen = useFetcher();
  // Shown, so seen: the mark on the menu clears for all of them at once.
  useEffect(() => {
    if (unseen > 0) void seen.submit({ intent: "seen", at: String(now) }, { method: "post" });
    // Once per page shown.
  }, [now]);
  return (
    <main className="mx-auto max-w-column space-y-3 px-(--gutter) py-4">
      <h1 className="text-display font-semibold">Mentions</h1>
      {mentions.length === 0 ? (
        <EmptyState
          title={paged ? "No older mentions" : "No mentions yet"}
          action={
            <Button asChild>
              <Link to="/">Browse the board</Link>
            </Button>
          }
        >
          When someone writes @your name in a post or comment{agent ? `, or @${agent.username}` : ""}, it shows here.
          Only you can see this list.
        </EmptyState>
      ) : (
        <MentionsProvider names={names}>
          <p className="text-body text-text-muted">
            Posts and comments that mention you{agent ? ` or your agent, ${agent.username}` : ""}. Only you can see this
            list.
          </p>
          <MentionList key={before ?? "newest"} mentions={mentions} seenAt={seenAt}>
            {(mention, fresh) => {
              const permalink = mention.type === "comment" ? commentPath(mention.postPath, mention.id) : mention.postPath;
              return (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <AuthorLine author={mention.author} createdAt={mention.mentionedAt} now={now} permalink={permalink} />
                    {fresh ? (
                      <span className="shrink-0 rounded-full bg-accent-soft px-2 text-meta font-semibold text-accent">New</span>
                    ) : null}
                  </div>
                  <p className="text-meta text-text-muted">
                    {agent && mention.targets.includes(agent.id)
                      ? mention.targets.includes(viewerId)
                        ? `Mentions you and your agent, ${agent.username}, `
                        : `Mentions your agent, ${agent.username}, `
                      : ""}
                    {mention.type === "post" ? "in the post " : "in a comment on "}
                    <Link to={permalink} className="font-medium text-text underline underline-offset-4">
                      {mention.postTitle}
                    </Link>
                  </p>
                  <RichText text={mention.text} className="line-clamp-6" outsideLinks={mention.author.outsideLinks} />
                </>
              );
            }}
          </MentionList>
          {older ? (
            <Button asChild variant="ghost">
              <Link to={`/mentions?${new URLSearchParams({ before: older })}`}>Older mentions</Link>
            </Button>
          ) : null}
        </MentionsProvider>
      )}
    </main>
  );
}

type Item = Route.ComponentProps["loaderData"]["mentions"][number];

/** How long after the page is drawn the pointer starts to count. */
const SETTLE_MS = 800;

/**
 * The list, with what came since the member last looked marked new. The
 * mark stays while the page is open, though the visit already counts them
 * seen, and comes off one at a time as the pointer passes over or focus
 * enters.
 */
function MentionList({
  mentions,
  seenAt,
  children,
}: {
  mentions: Item[];
  seenAt: number;
  children: (mention: Item, fresh: boolean) => ReactNode;
}) {
  const key = (mention: Item) => `${mention.type}:${mention.id}`;
  const [fresh, setFresh] = useState(() => new Set(mentions.filter((mention) => mention.mentionedAt > seenAt).map(key)));
  // A pointer resting where the page draws, as after choosing Mentions in
  // the menu, is no pass over a card: the browser reports one all the same.
  const shownAt = useRef(0);
  useEffect(() => {
    shownAt.current = performance.now();
  }, []);
  const read = (id: string) =>
    performance.now() - shownAt.current > SETTLE_MS &&
    setFresh((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  return (
    <ol className="space-y-3">
      {mentions.map((mention) => {
        const id = key(mention);
        const isFresh = fresh.has(id);
        return (
          <li
            key={id}
            // Also on moving, for a pointer already over it as the page drew it.
            onPointerEnter={() => read(id)}
            onPointerMove={isFresh ? () => read(id) : undefined}
            onFocus={() => read(id)}
            className={cn(
              "space-y-2 rounded-xl border bg-surface p-3 transition-colors duration-300 sm:p-4",
              isFresh ? "border-accent" : "border-border",
            )}
          >
            {children(mention, isFresh)}
          </li>
        );
      })}
    </ol>
  );
}
