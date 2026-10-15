import { env } from "cloudflare:workers";
import { Bookmark } from "lucide-react";
import { Link } from "react-router";

import { PostMenu } from "~/components/author-menus";
import { PostCard } from "~/components/post-card";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/states";
import { canVoteOn } from "~/lib/participation";
import { SAVED_LIMIT, savedPosts } from "~/lib/db/bookmarks.server";
import { viewerMarks } from "~/lib/db/marks.server";
import { useParticipation } from "~/components/use-participation";
import { requireAccount } from "~/lib/viewer.server";
import { privatePageMeta } from "~/lib/meta";

import type { Route } from "./+types/saved";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Saved posts", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const entries = await savedPosts(env.DB, viewer.id);
  const marks = await viewerMarks(env.DB, viewer.id, {
    posts: entries.flatMap((entry) => (entry.state === "live" ? [entry.post.id] : [])),
  });
  // Every listed post is saved, including the ones that are gone.
  marks.saved = entries.map((entry) => (entry.state === "live" ? entry.post.id : entry.postId));
  return { entries, marks, limit: SAVED_LIMIT, now: Math.floor(Date.now() / 1000) };
}

/** The signed-in account's saved posts, newest saved first. Private. */
export default function Saved({ loaderData }: Route.ComponentProps) {
  const { entries, limit, now } = loaderData;
  const participation = useParticipation(loaderData.marks, now);

  return (
    <main className="mx-auto max-w-column space-y-3 px-(--gutter) py-4">
      <h1 className="text-display font-semibold">Saved posts</h1>
      {entries.length === 0 ? (
        <EmptyState
          title="Nothing saved yet"
          action={
            <Button asChild>
              <Link to="/">Browse the board</Link>
            </Button>
          }
        >
          Save a post with its bookmark to find it here. Only you can see this list.
        </EmptyState>
      ) : (
        <>
          <p className="text-body text-text-muted">Only you can see this list.</p>
          {entries.map((entry) =>
            entry.state === "live" ? (
              <PostCard
                key={entry.post.id}
                post={{
                  ...entry.post,
                  score: participation.scoreOf("post", entry.post.id, entry.post.score),
                }}
                now={now}
                vote={participation.voteOf("post", entry.post.id)}
                onVote={(next) =>
                  void participation.vote("post", entry.post.id, entry.post.score, next)
                }
                canVote={canVoteOn(participation.viewer?.id, entry.post.author)}
                saved={participation.isSaved(entry.post.id)}
                onToggleSave={() => void participation.toggleSave(entry.post.id)}
                menu={<PostMenu post={entry.post} />}
              />
            ) : (
              // A post removed or deleted since it was saved: no title or link,
              // only the choice to unsave it.
              <article
                key={entry.postId}
                className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border-strong px-4 py-3 text-body text-text-muted"
              >
                <span>
                  {entry.state === "removed" ? "[removed by moderator]" : "[deleted by author]"}
                </span>
                <Button
                  variant="ghost"
                  aria-pressed={participation.isSaved(entry.postId)}
                  onClick={() => void participation.toggleSave(entry.postId)}
                >
                  <Bookmark
                    size={16}
                    aria-hidden
                    fill={participation.isSaved(entry.postId) ? "currentColor" : "none"}
                  />
                  {participation.isSaved(entry.postId) ? "Unsave" : "Save"}
                </Button>
              </article>
            ),
          )}
          {entries.length >= limit ? (
            <p className="text-center text-body text-text-muted">
              Showing your {limit} most recent saves.
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}
