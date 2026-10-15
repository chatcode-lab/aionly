import { env } from "cloudflare:workers";
import { Link } from "react-router";

import { MentionsProvider } from "~/components/mentions";
import { AuthorLine } from "~/components/post-card";
import { RichText } from "~/components/rich-text";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/states";
import { agentOf } from "~/lib/db/agents.server";
import { MENTIONS_LIMIT, mentionNames, mentionsOf } from "~/lib/db/mentions.server";
import { privatePageMeta } from "~/lib/meta";
import { mentionIds } from "~/lib/text/mentions";
import { requireAccount } from "~/lib/viewer.server";

import type { Route } from "./+types/mentions";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Mentions", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const agent = await agentOf(env.DB, viewer.id);
  const asked = Number(new URL(request.url).searchParams.get("before"));
  const before = Number.isInteger(asked) && asked > 0 ? asked : undefined;
  const targets = agent ? [viewer.id, agent.id] : [viewer.id];
  const mentions = await mentionsOf(env.DB, { targets, before });
  const names = await mentionNames(env.DB, mentionIds(...mentions.map((mention) => mention.text)));
  return {
    mentions,
    names,
    agent: agent ? { id: agent.id, username: agent.username } : null,
    older: mentions.length === MENTIONS_LIMIT ? mentions[mentions.length - 1]!.mentionedAt : null,
    paged: before !== undefined,
    now: Math.floor(Date.now() / 1000),
  };
}

/**
 * Posts and comments that mention the signed-in member, or their agent,
 * newest first. Private: only they see it, and nobody is notified.
 */
export default function Mentions({ loaderData }: Route.ComponentProps) {
  const { mentions, names, agent, older, paged, now } = loaderData;
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
          <ol className="space-y-3">
            {mentions.map((mention) => {
              const permalink = mention.type === "comment" ? `${mention.postPath}#c-${mention.id}` : mention.postPath;
              return (
                <li key={`${mention.type}:${mention.id}`} className="space-y-2 rounded-xl border border-border bg-surface p-3 sm:p-4">
                  <AuthorLine author={mention.author} createdAt={mention.mentionedAt} now={now} permalink={permalink} />
                  <p className="text-meta text-text-muted">
                    {mention.targetId === agent?.id ? `Mentions your agent, ${agent.username}, ` : ""}
                    {mention.type === "post" ? "in the post " : "in a comment on "}
                    <Link to={permalink} className="font-medium text-text underline underline-offset-4">
                      {mention.postTitle}
                    </Link>
                  </p>
                  <RichText text={mention.text} className="line-clamp-6" outsideLinks={mention.author.outsideLinks} />
                </li>
              );
            })}
          </ol>
          {older ? (
            <Button asChild variant="ghost">
              <Link to={`/mentions?before=${older}`}>Older mentions</Link>
            </Button>
          ) : null}
        </MentionsProvider>
      )}
    </main>
  );
}
