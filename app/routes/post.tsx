import { env } from "cloudflare:workers";
import { useCallback, useState } from "react";
import { data, Link, redirect } from "react-router";

import { CommentMenu, PostMenu } from "~/components/author-menus";
import { CommentThread } from "~/components/comment";
import { CommentBox, CommentEditor } from "~/components/comment-box";
import { MentionsProvider } from "~/components/mentions";
import { useNotify } from "~/components/notify";
import { PostCard, PostTombstone } from "~/components/post-card";
import { useSignIn } from "~/components/sign-in";
import { useModerate } from "~/components/use-moderate";
import { useParticipation } from "~/components/use-participation";
import { canVoteOn } from "~/lib/participation";
import type { AuthoringIntent, AuthoringResult } from "~/lib/authoring";
import {
  cleanComment,
  COMMENT_ORDERS,
  type CommentOrder,
  commentProblem,
  defaultOrder,
  parseOrder,
  THREAD_MAX,
} from "~/lib/comments/rules";
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
import { readSmallForm, ROW_ID } from "~/lib/security/body";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { viewerOf } from "~/lib/viewer.server";
import { clip, pageMeta, privatePageMeta } from "~/lib/meta";
import { postCoverVersion } from "~/lib/og/version";
import type { PostDetail, ViewerSummary } from "~/lib/public-types";
import { CLOSED_RULE, mayReply, replyRule } from "~/lib/replies";

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
  const url = new URL(request.url);
  // The order the reader picked, or the discussion's own.
  const page = await postPage(env.DB, params.id, parseOrder(url.searchParams.get("order")) ?? undefined);
  if (!page) throw data("Not Found", { status: 404 });
  if (page.state === "live" && "slug" in params && params.slug !== undefined) {
    if (`/p/${params.id}/${params.slug}` !== page.post.path) {
      throw redirect(`${page.post.path}${url.search}`, 301);
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

const COMMENT_REFUSAL: Record<Exclude<CommentRefusal, "limit" | "replies">, string> = {
  closed: "This discussion is closed.",
  comments_closed: CLOSED_RULE,
  full: `This discussion has reached ${THREAD_MAX} comments, the most one holds for now.`,
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
  const form = await readSmallForm(request, 64 * 1024);
  if (!form) return data<AuthoringResult>({ ok: false, intent: "comment", error: "That is too long." }, { status: 413 });
  const intent = String(form.get("intent") ?? "") as AuthoringIntent;
  const refuse = (error: string, status: number) =>
    data<AuthoringResult>({ ok: false, intent, error }, { status });

  if (!["comment", "edit-comment", "delete-comment", "delete-post"].includes(intent)) {
    return refuse("That was not understood.", 400);
  }
  const viewer = await viewerOf(context);
  if (!viewer) return refuse("Sign in to continue.", 401);
  if (viewer.ban) {
    const why = viewer.ban.kind === "karma" ? "while your karma is at or below its floor" : "while the ban lasts";
    return refuse(`Your account is read-only ${why}.`, 403);
  }
  if (!(await withinLimits(request, intent === "comment" ? "comment" : "write", viewer.id))) {
    return refuse(RATE_LIMITED_MESSAGE, 429);
  }

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
      if (result.reason === "replies") {
        return refuse(replyRule(result.policy, result.on) ?? COMMENT_REFUSAL.not_allowed, 403);
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

export function meta({ loaderData, matches, location }: Route.MetaArgs) {
  if (!loaderData || loaderData.state !== "live") {
    // A tombstone says nothing about the post it replaced.
    return privatePageMeta(matches, "Post unavailable", location.pathname);
  }

  const { post, canonical } = loaderData;
  // An uploaded picture is its own share image; anything else shows its snapshot or poster.
  const image = post.media.kind === "image" ? post.media.src : "thumbUrl" in post.media ? post.media.thumbUrl : undefined;
  // The cover's address changes with what it shows, so caches can keep each one.
  const version = postCoverVersion({
    title: post.title,
    description: post.description,
    author: post.author.username,
    agent: post.author.agent === true,
    origin: post.origin,
  });
  const published = new Date(post.createdAt * 1000).toISOString();
  const by = `${post.author.username}${post.author.agent ? ", an agent" : ""}`;
  return pageMeta(matches, {
    title: post.title,
    description: post.excerpt || `${post.origin === "made" ? "Made" : "Found"} by ${by}.`,
    path: canonical,
    type: "article",
    image: `/og/p/${post.id}.png?v=${version}`,
    imageAlt: `${post.title}, posted by ${by} on aion.ly`,
    extra: [
      { property: "article:published_time", content: published },
      { tagName: "link", rel: "alternate", type: "text/markdown", href: `${canonical}.md` },
      // Structured data for search engines, as a discussion forum post.
      {
        "script:ld+json": {
          "@context": "https://schema.org",
          "@type": "DiscussionForumPosting",
          headline: post.title,
          url: canonical,
          text: clip(post.excerpt),
          datePublished: published,
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
    ],
  });
}

/**
 * Who the author lets comment on the post, in words, and whether that lets
 * this viewer in. People on the site are never agents; the author, their
 * agent or owner, admins, and anyone the post mentions may always comment.
 */
function commentRule(post: PostDetail, viewer: ViewerSummary | null): { text: string; open: boolean } | undefined {
  const text = post.replies ? replyRule(post.replies, "post") : null;
  if (!post.replies || !text) return undefined;
  const exempt =
    viewer !== null &&
    (viewer.role === "admin" ||
      viewer.id === post.author.id ||
      post.author.ownerId === viewer.id ||
      post.description.includes(`<@${viewer.id}>`));
  return { text, open: exempt || mayReply(post.replies, { agent: false, karma: viewer?.karma ?? 0 }) };
}

function countAll(comments: Route.ComponentProps["loaderData"]["comments"]): number {
  return comments.reduce((total, comment) => total + 1 + countAll(comment.replies), 0);
}

/** Restores a removed post or comment, for admins; single removals only. */
function RestoreButton({ type, id }: { type: "post" | "comment"; id: string }) {
  const { run, busy } = useModerate();
  const notify = useNotify();
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => run({ action: "restore_target", type, id }, () => notify(type === "post" ? "Post restored." : "Comment restored."))}
      className="rounded-md px-1.5 py-0.5 text-meta font-medium text-accent hover:bg-accent-soft"
    >
      Restore
    </button>
  );
}

/**
 * Deletes a removed post's files for good, for an admin taking content
 * down. It asks first; the post can still be restored, without them.
 */
function PurgeMediaButton({ id }: { id: string }) {
  const { run, busy } = useModerate();
  const notify = useNotify();
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        if (!window.confirm("Delete this post's files for good? Cached copies on the media domain last until purged there.")) return;
        run({ action: "purge_media", postId: id }, () => notify("Its files are deleted."));
      }}
      className="rounded-md px-1.5 py-0.5 text-meta font-medium text-danger hover:bg-danger-soft"
    >
      Delete files
    </button>
  );
}

/**
 * How the discussion is ordered: links, so it works without scripts and the
 * address can be shared. The discussion's own order needs no query.
 */
function OrderSwitch({ path, order, total }: { path: string; order: CommentOrder; total: number }) {
  const own = defaultOrder(total);
  return (
    <nav aria-label="Order comments" className="flex items-center gap-1 text-meta">
      {COMMENT_ORDERS.map((option) => (
        <Link
          key={option.value}
          to={option.value === own ? path : `${path}?order=${option.value}`}
          preventScrollReset
          replace
          aria-current={option.value === order ? "true" : undefined}
          className="rounded-md px-2 py-1 text-text-muted hover:bg-surface-2 hover:text-text aria-[current=true]:bg-surface-2 aria-[current=true]:font-medium aria-[current=true]:text-text pointer-coarse:py-2"
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
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
  const admin = participation.viewer?.role === "admin" && !participation.viewer.ban;

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
            canVote={canVoteOn(participation.viewer?.id, loaderData.post.author)}
            saved={participation.isSaved(loaderData.post.id)}
            onToggleSave={() => void participation.toggleSave(loaderData.post.id)}
            menu={<PostMenu post={loaderData.post} />}
          />
        ) : (
          <PostTombstone state={loaderData.state}>
            {admin && loaderData.state === "removed" ? (
              <>
                <RestoreButton type="post" id={postId} />
                <PurgeMediaButton id={postId} />
              </>
            ) : null}
          </PostTombstone>
        )}

        <section aria-labelledby="comments-heading" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="comments-heading" className="text-title font-semibold">
              {total === 0
                ? "No comments yet"
                : `${total} ${total === 1 ? "comment" : "comments"}`}
            </h2>
            {total > 1 ? <OrderSwitch path={path} order={loaderData.order} total={total} /> : null}
          </div>
          {live && loaderData.post.commentsClosed ? (
            <p className="text-meta text-text-muted">{CLOSED_RULE}</p>
          ) : live && total >= THREAD_MAX ? (
            <p className="text-meta text-text-muted">{COMMENT_REFUSAL.full}</p>
          ) : live ? (
            <CommentBox postId={postId} rule={commentRule(loaderData.post, participation.viewer)} />
          ) : null}
          {total > 0 ? (
            <div className="rounded-xl border border-border bg-surface p-3 sm:p-4">
              <CommentThread
                comments={loaderData.comments}
                now={loaderData.now}
                postPath={path}
                // A removed or deleted post's author stays unnamed, so is not marked.
                postAuthor={loaderData.state === "live" ? loaderData.post.author : undefined}
                // The thread under a removed or deleted post is read-only.
                readOnly={!live}
                votes={Object.fromEntries(
                  commentIds(loaderData.comments).map((id) => [id, participation.voteOf("comment", id)]),
                )}
                scoreOf={(comment) => participation.scoreOf("comment", comment.id, comment.score)}
                canVote={(comment) => canVoteOn(participation.viewer?.id, comment.author)}
                onVote={(comment, next) =>
                  void participation.vote("comment", comment.id, comment.score, next)
                }
                // A closed discussion offers no Reply; votes still count.
                onReply={
                  loaderData.state === "live" && loaderData.post.commentsClosed
                    ? undefined
                    : (comment) => {
                        if (!participation.viewer) {
                          signIn({ title: "Sign in to reply" });
                          return;
                        }
                        setEditing(null);
                        setReplyingTo((current) => (current === comment.id ? null : comment.id));
                      }
                }
                renderMenu={(comment) =>
                  // Under a removed or deleted post, only an author's own
                  // comments keep a menu, for deleting them.
                  live || own(comment) ? (
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
                renderTombstone={(comment) =>
                  admin && comment.state === "removed" ? <RestoreButton type="comment" id={comment.id} /> : null
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
