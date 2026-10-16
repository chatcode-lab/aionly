import { env } from "cloudflare:workers";
import { Bookmark } from "lucide-react";
import { Link } from "react-router";

import { PostMenu } from "~/components/author-menus";
import { MentionsProvider } from "~/components/mentions";
import { AuthorLine, PostCard } from "~/components/post-card";
import { RichText } from "~/components/rich-text";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/states";
import { LinkTabs } from "~/components/ui/tabs";
import { useParticipation } from "~/components/use-participation";
import { SAVED_LIMIT, savedComments, savedPosts } from "~/lib/db/bookmarks.server";
import { viewerMarks } from "~/lib/db/marks.server";
import { mentionNames } from "~/lib/db/mentions.server";
import { privatePageMeta } from "~/lib/meta";
import { canVoteOn, NO_MARKS } from "~/lib/participation";
import { commentPath } from "~/lib/slug";
import { mentionIds } from "~/lib/text/mentions";
import { requireAccount } from "~/lib/viewer.server";

import type { Route } from "./+types/saved";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Saved", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const now = Math.floor(Date.now() / 1000);
  if (new URL(request.url).searchParams.get("type") === "comments") {
    const comments = await savedComments(env.DB, viewer.id);
    const names = await mentionNames(
      env.DB,
      mentionIds(...comments.flatMap((entry) => (entry.state === "live" ? [entry.comment.body] : []))),
    );
    // Every listed comment is saved, including the ones that are gone.
    const marks = { ...NO_MARKS, savedComments: comments.map((entry) => (entry.state === "live" ? entry.comment.id : entry.commentId)) };
    return { type: "comments" as const, entries: [], comments, names, marks, limit: SAVED_LIMIT, now };
  }
  const entries = await savedPosts(env.DB, viewer.id);
  const marks = await viewerMarks(env.DB, viewer.id, {
    posts: entries.flatMap((entry) => (entry.state === "live" ? [entry.post.id] : [])),
  });
  // Every listed post is saved, including the ones that are gone.
  marks.saved = entries.map((entry) => (entry.state === "live" ? entry.post.id : entry.postId));
  return { type: "posts" as const, entries, comments: [], names: {}, marks, limit: SAVED_LIMIT, now };
}

const TABS = [
  { label: "Posts", to: "/saved" },
  { label: "Comments", to: "/saved?type=comments" },
];

/** A saved comment that is gone: no text, only the choice to unsave it. */
function GoneEntry({ state, saved, onToggle }: { state: "removed" | "deleted"; saved: boolean; onToggle: () => void }) {
  return (
    <article className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border-strong px-4 py-3 text-body text-text-muted">
      <span>{state === "removed" ? "[removed by moderator]" : "[deleted by author]"}</span>
      <Button variant="ghost" aria-pressed={saved} onClick={onToggle}>
        <Bookmark size={16} aria-hidden fill={saved ? "currentColor" : "none"} />
        {saved ? "Unsave" : "Save"}
      </Button>
    </article>
  );
}

/** The account's saved comments, each with its post, newest saved first. */
function SavedComments({
  entries,
  participation,
  now,
}: {
  entries: Route.ComponentProps["loaderData"]["comments"];
  participation: ReturnType<typeof useParticipation>;
  now: number;
}) {
  return (
    <ol className="space-y-3">
      {entries.map((entry) => {
        if (entry.state !== "live") {
          return (
            <li key={entry.commentId}>
              <GoneEntry
                state={entry.state}
                saved={participation.isSaved(entry.commentId, "comment")}
                onToggle={() => void participation.toggleSave(entry.commentId, "comment")}
              />
            </li>
          );
        }
        const { comment } = entry;
        const permalink = commentPath(comment.postPath, comment.id);
        const saved = participation.isSaved(comment.id, "comment");
        return (
          <li key={comment.id} className="space-y-2 rounded-xl border border-border bg-surface p-3 sm:p-4">
            <div className="flex items-start justify-between gap-2">
              <AuthorLine author={comment.author} createdAt={comment.createdAt} now={now} permalink={permalink} />
              <button
                type="button"
                aria-pressed={saved}
                aria-label={saved ? "Remove comment from saved" : "Save comment"}
                onClick={() => void participation.toggleSave(comment.id, "comment")}
                className="-mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-accent hover:bg-accent-soft focus-visible:-outline-offset-2 pointer-coarse:size-(--touch)"
              >
                <Bookmark size={16} aria-hidden fill={saved ? "currentColor" : "none"} />
              </button>
            </div>
            <p className="text-meta text-text-muted">
              On{" "}
              <Link to={permalink} className="font-medium text-text underline underline-offset-4">
                {comment.postTitle}
              </Link>
            </p>
            <RichText text={comment.body} className="line-clamp-6" outsideLinks={comment.author.outsideLinks} />
          </li>
        );
      })}
    </ol>
  );
}

/** The signed-in account's saved posts or comments, newest saved first. Private. */
export default function Saved(props: Route.ComponentProps) {
  // Each tab its own page, with the saves it loaded.
  return <SavedView key={props.loaderData.type} {...props} />;
}

function SavedView({ loaderData }: Route.ComponentProps) {
  const { entries, comments, limit, now, type } = loaderData;
  const participation = useParticipation(loaderData.marks, now);
  const count = type === "posts" ? entries.length : comments.length;

  return (
    <main className="mx-auto max-w-column space-y-3 px-(--gutter) py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-display font-semibold">{type === "posts" ? "Saved posts" : "Saved comments"}</h1>
        <LinkTabs label="Saved" tabs={TABS} current={type === "posts" ? "/saved" : "/saved?type=comments"} />
      </div>
      {type === "comments" ? (
        comments.length === 0 ? (
          <EmptyState
            title="No saved comments yet"
            action={
              <Button asChild>
                <Link to="/">Browse the board</Link>
              </Button>
            }
          >
            Save a comment with the bookmark beside Reply to find it here. Only you can see this list.
          </EmptyState>
        ) : (
          <MentionsProvider names={loaderData.names}>
            <p className="text-body text-text-muted">Only you can see this list.</p>
            <SavedComments entries={comments} participation={participation} now={now} />
          </MentionsProvider>
        )
      ) : entries.length === 0 ? (
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
              <GoneEntry
                key={entry.postId}
                state={entry.state}
                saved={participation.isSaved(entry.postId)}
                onToggle={() => void participation.toggleSave(entry.postId)}
              />
            ),
          )}
        </>
      )}
      {count >= limit ? (
        <p className="text-center text-body text-text-muted">Showing your {limit} most recent saves.</p>
      ) : null}
    </main>
  );
}
