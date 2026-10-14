import { env } from "cloudflare:workers";
import { data } from "react-router";

import { CommentThread } from "~/components/comment";
import { PostCard, PostTombstone } from "~/components/post-card";
import { viewerMarks } from "~/lib/db/marks.server";
import { postPage } from "~/lib/db/posts.server";
import type { CommentData } from "~/lib/public-types";
import { useParticipation } from "~/components/use-participation";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/post";

function commentIds(comments: CommentData[]): string[] {
  return comments.flatMap((comment) => [comment.id, ...commentIds(comment.replies)]);
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const page = await postPage(env.DB, params.id);
  if (!page) throw data("Not Found", { status: 404 });

  const viewer = await viewerOf(context);
  const marks = await viewerMarks(env.DB, viewer?.id ?? null, {
    posts: page.state === "live" ? [page.post.id] : [],
    comments: commentIds(page.comments),
  });
  const now = Math.floor(Date.now() / 1000);
  const canonical = `${new URL(request.url).origin}/p/${params.id}`;
  // A removed or deleted post answers 410: gone, and not to be indexed.
  return page.state === "live"
    ? { ...page, marks, now, canonical }
    : data({ ...page, marks, now, canonical }, { status: 410 });
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData || loaderData.state !== "live") {
    // A tombstone says nothing about the post it replaced.
    return [
      { title: "Post unavailable · aion.ly" },
      { name: "robots", content: "noindex" },
    ];
  }

  const { post, canonical } = loaderData;
  const summary =
    post.excerpt.length > 160 ? `${post.excerpt.slice(0, 159).trimEnd()}…` : post.excerpt;
  const image = "thumbUrl" in post.media ? post.media.thumbUrl : undefined;
  return [
    { title: `${post.title} · aion.ly` },
    { name: "description", content: summary },
    { tagName: "link", rel: "canonical", href: canonical },
    { property: "og:type", content: "article" },
    { property: "og:site_name", content: "aion.ly" },
    { property: "og:title", content: post.title },
    { property: "og:description", content: summary },
    { property: "og:url", content: canonical },
    ...(image
      ? [
          { property: "og:image", content: new URL(image, canonical).href },
          { name: "twitter:card", content: "summary_large_image" },
        ]
      : [{ name: "twitter:card", content: "summary" }]),
  ];
}

function countAll(comments: Route.ComponentProps["loaderData"]["comments"]): number {
  return comments.reduce((total, comment) => total + 1 + countAll(comment.replies), 0);
}

export default function Post({ loaderData }: Route.ComponentProps) {
  const participation = useParticipation(loaderData.marks, loaderData.now);
  const live = loaderData.state === "live";
  const total = countAll(loaderData.comments);

  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-4">
      {loaderData.state === "live" ? (
        <PostCard
          post={{
            ...loaderData.post,
            score: participation.scoreOf("post", loaderData.post.id, loaderData.post.score),
          }}
          description={loaderData.post.description}
          now={loaderData.now}
          vote={participation.voteOf("post", loaderData.post.id)}
          onVote={(next) =>
            void participation.vote("post", loaderData.post.id, loaderData.post.score, next)
          }
          canVote={participation.viewer?.id !== loaderData.post.author.id}
          saved={participation.isSaved(loaderData.post.id)}
          onToggleSave={() => void participation.toggleSave(loaderData.post.id)}
        />
      ) : (
        <PostTombstone state={loaderData.state} />
      )}

      <section aria-labelledby="comments-heading">
        <h2 id="comments-heading" className="text-title font-semibold">
          {total === 0
            ? "No comments yet"
            : `${total} ${total === 1 ? "comment" : "comments"}`}
        </h2>
        {total > 0 ? (
          <div className="mt-3 rounded-xl border border-border bg-surface p-3 sm:p-4">
            <CommentThread
              comments={loaderData.comments}
              now={loaderData.now}
              postId={loaderData.canonical.split("/").pop() ?? ""}
              // The thread under a removed or deleted post is read-only.
              readOnly={!live}
              votes={Object.fromEntries(
                commentIds(loaderData.comments).map((id) => [id, participation.voteOf("comment", id)]),
              )}
              scoreOf={(comment) => participation.scoreOf("comment", comment.id, comment.score)}
              canVote={(comment) => participation.viewer?.id !== comment.author?.id}
              onVote={(comment, next) =>
                void participation.vote("comment", comment.id, comment.score, next)
              }
            />
          </div>
        ) : null}
      </section>
    </main>
  );
}
