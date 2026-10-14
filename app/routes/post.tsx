import { env } from "cloudflare:workers";
import { useCallback, useState } from "react";
import { data, redirect } from "react-router";

import { CommentMenu, PostMenu } from "~/components/author-menus";
import { CommentThread } from "~/components/comment";
import { CommentBox, CommentEditor } from "~/components/comment-box";
import { MentionsProvider } from "~/components/mentions";
import { PostCard, PostTombstone } from "~/components/post-card";
import { useSignIn } from "~/components/sign-in";
import { useParticipation } from "~/components/use-participation";
import type { AuthoringIntent, AuthoringResult } from "~/lib/authoring";
import { cleanComment, commentProblem } from "~/lib/comments/rules";
import {
  addComment,
  type CommentRefusal,
  deleteComment,
  deletePost,
  editComment,
} from "~/lib/db/authoring.server";
import { viewerMarks } from "~/lib/db/marks.server";
import { linkMentions, mentionHosts, mentionNames } from "~/lib/db/mentions.server";
import { postPage } from "~/lib/db/posts.server";
import { formatWait } from "~/lib/format";
import { newId } from "~/lib/ids";
import type { CommentData } from "~/lib/public-types";
import { mentionIds, replaceMentions } from "~/lib/text/mentions";
import { ROW_ID } from "~/lib/security/body";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/post";

function commentIds(comments: CommentData[]): string[] {
  return comments.flatMap((comment) => [comment.id, ...commentIds(comment.replies)]);
}

function commentBodies(comments: CommentData[]): string[] {
  return comments.flatMap((comment) => [comment.body ?? "", ...commentBodies(comment.replies)]);
}

/**
 * A post answers at its short address, `/p/<id>`, and at its canonical one
 * with the title's slug. Both show the page, with the canonical address in
 * its link tag; an outdated or mistyped slug redirects to the current one.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const page = await postPage(env.DB, params.id);
  if (!page) throw data("Not Found", { status: 404 });
  const url = new URL(request.url);
  if (page.state === "live" && "slug" in params && params.slug !== undefined) {
    if (`/p/${params.id}/${params.slug}` !== page.post.path) {
      throw redirect(page.post.path, 301);
    }
  }

  // The current names of everyone mentioned in the post and its thread.
  const mentions = await mentionNames(
    env.DB,
    mentionIds(page.state === "live" ? page.post.description : "", ...commentBodies(page.comments)),
  );
  if (page.state === "live") page.post.excerpt = replaceMentions(page.post.excerpt, mentions);

  const viewer = await viewerOf(context);
  const marks = await viewerMarks(env.DB, viewer?.id ?? null, {
    posts: page.state === "live" ? [page.post.id] : [],
    comments: commentIds(page.comments),
  });
  const now = Math.floor(Date.now() / 1000);
  const canonical = `${url.origin}${page.state === "live" ? page.post.path : `/p/${params.id}`}`;
  const id = params.id;
  // A removed or deleted post answers 410: gone, and not to be indexed.
  return page.state === "live"
    ? { ...page, id, marks, mentions, now, canonical }
    : data({ ...page, id, marks, mentions, now, canonical }, { status: 410 });
}

const COMMENT_REFUSAL: Record<Exclude<CommentRefusal, "limit">, string> = {
  closed: "This discussion is closed.",
  parent: "That comment is no longer here to reply to.",
  depth: "Replies go no deeper here. Reply further up the thread.",
  not_allowed: "Your account can't comment.",
};

const CHANGE_REFUSAL = {
  not_found: "That is no longer here.",
  closed: "This can no longer be changed.",
  window: "The title can only change in the first hour.",
  not_allowed: "Your account can't make changes.",
} as const;

/**
 * Adds, edits, and deletes comments, and deletes the post, for its author.
 * Every answer is data for the form that asked, so the page stays.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  // A comment is at most 5,000 characters; nothing bigger is read.
  if (Number(request.headers.get("Content-Length") ?? "0") > 64 * 1024) {
    return data<AuthoringResult>({ ok: false, intent: "comment", error: "That is too long." }, { status: 413 });
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "") as AuthoringIntent;
  const refuse = (error: string, status: number) =>
    data<AuthoringResult>({ ok: false, intent, error }, { status });

  if (!["comment", "edit-comment", "delete-comment", "delete-post"].includes(intent)) {
    return refuse("That was not understood.", 400);
  }
  const viewer = await viewerOf(context);
  if (!viewer) return refuse("Sign in to continue.", 401);
  if (viewer.ban) return refuse("Your account is read-only while the ban lasts.", 403);

  const now = Math.floor(Date.now() / 1000);
  const postId = params.id;
  const id = String(form.get("id") ?? "");
  const body = cleanComment(String(form.get("body") ?? ""));

  switch (intent) {
    case "comment": {
      const problem = commentProblem(body);
      if (problem) return refuse(problem, 400);
      const parent = String(form.get("parent") ?? "");
      if (parent && !ROW_ID.test(parent)) return refuse("That was not understood.", 400);
      const commentId = newId();
      const result = await addComment(env.DB, {
        id: commentId,
        postId,
        parentId: parent || null,
        authorId: viewer.id,
        body: await linkMentions(env.DB, body, mentionHosts(request)),
        now,
      });
      if (result.ok) return { ok: true, intent, id: commentId } satisfies AuthoringResult;
      if (result.reason === "limit") {
        return refuse(
          `That is 100 comments in a day. Try again in ${formatWait((result.retryAt ?? now) - now)}; your draft is saved.`,
          429,
        );
      }
      return refuse(COMMENT_REFUSAL[result.reason], 403);
    }
    case "edit-comment": {
      const problem = commentProblem(body);
      if (problem) return refuse(problem, 400);
      if (!ROW_ID.test(id)) return refuse("That was not understood.", 400);
      const stored = await linkMentions(env.DB, body, mentionHosts(request));
      const result = await editComment(env.DB, { id, authorId: viewer.id, body: stored, now });
      if (result.ok) return { ok: true, intent, id } satisfies AuthoringResult;
      return refuse(CHANGE_REFUSAL[result.reason], result.reason === "not_found" ? 404 : 403);
    }
    case "delete-comment": {
      if (!ROW_ID.test(id)) return refuse("That was not understood.", 400);
      const result = await deleteComment(env.DB, { id, authorId: viewer.id, now });
      if (result.ok) return { ok: true, intent, id } satisfies AuthoringResult;
      return refuse(CHANGE_REFUSAL[result.reason], result.reason === "not_found" ? 404 : 403);
    }
    case "delete-post": {
      const result = await deletePost(env.DB, { id: postId, authorId: viewer.id, now });
      if (result.ok) return { ok: true, intent, id: postId } satisfies AuthoringResult;
      return refuse(CHANGE_REFUSAL[result.reason], result.reason === "not_found" ? 404 : 403);
    }
  }
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
    // Structured data for search engines, as a discussion forum post.
    {
      "script:ld+json": {
        "@context": "https://schema.org",
        "@type": "DiscussionForumPosting",
        headline: post.title,
        url: canonical,
        text: summary,
        datePublished: new Date(post.createdAt * 1000).toISOString(),
        author: {
          "@type": post.author.agent ? "Organization" : "Person",
          name: post.author.username,
          ...(post.author.username === "[deleted]" ? {} : { url: new URL(`/u/${post.author.username}`, canonical).href }),
        },
        commentCount: countAll(loaderData.comments),
        interactionStatistic: {
          "@type": "InteractionCounter",
          interactionType: "https://schema.org/LikeAction",
          userInteractionCount: Math.max(post.score, 0),
        },
        sharedContent: { "@type": "WebPage", url: post.url },
        ...(image ? { image: new URL(image, canonical).href } : {}),
      },
    },
  ];
}

function countAll(comments: Route.ComponentProps["loaderData"]["comments"]): number {
  return comments.reduce((total, comment) => total + 1 + countAll(comment.replies), 0);
}

export default function Post({ loaderData }: Route.ComponentProps) {
  const participation = useParticipation(loaderData.marks, loaderData.now);
  const signIn = useSignIn();
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const live = loaderData.state === "live";
  const total = countAll(loaderData.comments);
  const postId = loaderData.id;
  const path = loaderData.state === "live" ? loaderData.post.path : `/p/${postId}`;
  const viewerId = participation.viewer?.id;
  const closeReply = useCallback(() => setReplyingTo(null), []);
  const closeEditor = useCallback(() => setEditing(null), []);
  const own = (comment: CommentData) => viewerId !== undefined && comment.author?.id === viewerId;

  return (
    <MentionsProvider names={loaderData.mentions}>
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
            menu={<PostMenu post={loaderData.post} />}
          />
        ) : (
          <PostTombstone state={loaderData.state} />
        )}

        <section aria-labelledby="comments-heading" className="space-y-3">
          <h2 id="comments-heading" className="text-title font-semibold">
            {total === 0
              ? "No comments yet"
              : `${total} ${total === 1 ? "comment" : "comments"}`}
          </h2>
          {live ? <CommentBox postId={postId} /> : null}
          {total > 0 ? (
            <div className="rounded-xl border border-border bg-surface p-3 sm:p-4">
              <CommentThread
                comments={loaderData.comments}
                now={loaderData.now}
                postPath={path}
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
                onReply={(comment) => {
                  if (!participation.viewer) {
                    signIn({ title: "Sign in to reply" });
                    return;
                  }
                  setEditing(null);
                  setReplyingTo((current) => (current === comment.id ? null : comment.id));
                }}
                renderMenu={(comment) =>
                  own(comment) ? (
                    <CommentMenu
                      postId={postId}
                      comment={comment}
                      onEdit={
                        live
                          ? () => {
                              setReplyingTo(null);
                              setEditing(comment.id);
                            }
                          : undefined
                      }
                    />
                  ) : null
                }
                renderBody={(comment) =>
                  live && editing === comment.id ? (
                    <CommentEditor
                      postId={postId}
                      commentId={comment.id}
                      body={comment.body ?? ""}
                      onDone={closeEditor}
                    />
                  ) : undefined
                }
                renderAfter={(comment) =>
                  live && replyingTo === comment.id ? (
                    <div className="mt-2">
                      <CommentBox
                        postId={postId}
                        parentId={comment.id}
                        onCancel={closeReply}
                        onDone={closeReply}
                      />
                    </div>
                  ) : null
                }
              />
            </div>
          ) : null}
        </section>
      </main>
    </MentionsProvider>
  );
}
