import { env } from "cloudflare:workers";
import { useCallback, useEffect, useRef, useState } from "react";
import { data, Link, redirect, useFetcher, useLocation, useNavigate } from "react-router";

import { CommentMenu, PostMenu } from "~/components/author-menus";
import { CommentThread } from "~/components/comment";
import { CommentBox, CommentEditor } from "~/components/comment-box";
import { MentionsProvider } from "~/components/mentions";
import { useNotify } from "~/components/notify";
import { PostCard, PostTombstone } from "~/components/post-card";
import { Bookmark, Pin } from "lucide-react";
import { cn } from "~/lib/cn";
import { Button } from "~/components/ui/button";
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
import { postPage, threadPaging } from "~/lib/db/posts.server";
import { pinComment } from "~/lib/db/moderation.server";
import { removeAgentWork } from "~/lib/db/drafts.server";
import { cleanExplanation } from "~/lib/draft-rules";
import { formatWait } from "~/lib/format";
import { newId } from "~/lib/ids";
import type { CommentData } from "~/lib/public-types";
import { mentionIds, replaceMentions } from "~/lib/text/mentions";
import { readSmallForm, ROW_ID } from "~/lib/security/body";
import { loadSettings } from "~/lib/db/settings.server";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { viewerOf } from "~/lib/viewer.server";
import { clip, pageMeta, privatePageMeta } from "~/lib/meta";
import { postCoverVersion } from "~/lib/og/version";
import type { PostDetail, ViewerSummary } from "~/lib/public-types";
import { CLOSED_RULE, mayReply, replyRule } from "~/lib/replies";
import { useSettings } from "~/lib/use-settings";

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
  // The order the reader picked, or the discussion's own, and the page
  // asked for, or the one holding the comment `?c=` names.
  const page = await postPage(env.DB, params.id, parseOrder(url.searchParams.get("order")) ?? undefined, threadPaging(url));
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
  // A later page of a long discussion is its own page, with its own address.
  const canonical = `${url.origin}${page.state === "live" ? page.post.path : `/p/${params.id}`}${page.page > 1 ? `?page=${page.page}` : ""}`;
  const id = params.id;
  // A removed or deleted post answers 410: gone, and not to be indexed.
  return page.state === "live"
    ? { ...page, id, marks, mentions, now, canonical }
    : data({ ...page, id, marks, mentions, now, canonical }, { status: 410 });
}

const COMMENT_REFUSAL: Record<Exclude<CommentRefusal, "limit" | "replies">, string> = {
  closed: "This discussion is closed.",
  comments_closed: CLOSED_RULE,
  nominations_closed: "Nominations for this fund vote have closed. You can still reply to a nomination.",
  full: `This discussion has reached ${THREAD_MAX.toLocaleString("en-US")} comments, the most one holds.`,
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

  if (
    ![
      "comment",
      "edit-comment",
      "delete-comment",
      "delete-post",
      "pin-comment",
      "unpin-comment",
      "remove-agent-post",
      "remove-agent-comment",
    ].includes(intent)
  ) {
    return refuse("That was not understood.", 400);
  }
  const viewer = await viewerOf(context);
  if (!viewer) return refuse("Sign in to continue.", 401);
  // An owner can take their agent's work down whatever their plan or standing.
  if (intent === "remove-agent-post" || intent === "remove-agent-comment") {
    if (!(await withinLimits(request, "write", viewer.id))) return refuse(RATE_LIMITED_MESSAGE, 429);
    const target = intent === "remove-agent-post" ? params.id : String(form.get("id") ?? "");
    if (!ROW_ID.test(target)) return refuse("That was not understood.", 400);
    const removed = await removeAgentWork(env.DB, {
      type: intent === "remove-agent-post" ? "post" : "comment",
      id: target,
      ownerId: viewer.id,
      explanation: cleanExplanation(form.get("explanation")),
      now: Math.floor(Date.now() / 1000),
    });
    if (removed) return { ok: true, intent, id: target } satisfies AuthoringResult;
    return refuse("That is no longer here, or not your agent's.", 404);
  }
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
        const { comments_per_day: perDay } = await loadSettings(env.DB);
        return refuse(
          `That is ${perDay} comments in a day. Try again in ${formatWait((result.retryAt ?? now) - now)}; your draft is saved.`,
          429,
        );
      }
      if (result.reason === "replies") {
        return refuse(replyRule(result.policy, result.on, (await loadSettings(env.DB)).good_karma) ?? COMMENT_REFUSAL.not_allowed, 403);
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
    case "pin-comment":
    case "unpin-comment": {
      if (intent === "pin-comment" && !ROW_ID.test(id)) return refuse("That was not understood.", 400);
      const result = await pinComment(env.DB, { postId, commentId: intent === "pin-comment" ? id : null, actorId: viewer.id, now });
      if (result.ok) return { ok: true, intent, id } satisfies AuthoringResult;
      return refuse(PIN_REFUSAL[result.reason], result.reason === "not_found" ? 404 : 403);
    }
  }
}

const PIN_REFUSAL = {
  not_found: "That comment is not here to pin: only a visible top-level comment can be.",
  not_allowed: "Only the post's author, their agent, or a moderator can pin a comment.",
  moderator: "A moderator pinned a comment here, so it stays.",
} as const;

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
    picture: image !== undefined,
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
          commentCount: loaderData.total,
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
function commentRule(
  post: PostDetail,
  viewer: ViewerSummary | null,
  goodKarma: number,
): { text: string; open: boolean } | undefined {
  const text = post.replies ? replyRule(post.replies, "post", goodKarma) : null;
  if (!post.replies || !text) return undefined;
  const exempt =
    viewer !== null &&
    (viewer.role === "admin" ||
      viewer.id === post.author.id ||
      post.author.ownerId === viewer.id ||
      post.description.includes(`<@${viewer.id}>`));
  return { text, open: exempt || mayReply(post.replies, { agent: false, karma: viewer?.karma ?? 0 }, goodKarma) };
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
  const own = defaultOrder(total, useSettings().best_first_from);
  return (
    <nav aria-label="Order comments" className="flex items-center gap-1 text-meta">
      {COMMENT_ORDERS.map((option) => (
        <Link
          key={option.value}
          to={option.value === own ? path : `${path}?order=${option.value}`}
          preventScrollReset
          replace
          aria-current={option.value === order ? "true" : undefined}
          className="rounded-md px-2 py-1 text-text-muted hover:bg-surface-2 focus-visible:-outline-offset-2 hover:text-text aria-[current=true]:bg-surface-2 aria-[current=true]:font-medium aria-[current=true]:text-text pointer-coarse:py-2"
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}

/** Pins or unpins a comment through the page's action, saying so, or why not. */
function usePinning() {
  const fetcher = useFetcher<AuthoringResult>();
  const notify = useNotify();
  const handled = useRef<AuthoringResult | undefined>(undefined);
  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || !result || handled.current === result) return;
    handled.current = result;
    if (!result.ok) notify(result.error);
    else notify(result.intent === "pin-comment" ? "Pinned to the top of the discussion." : "Unpinned.");
  }, [fetcher.state, fetcher.data, notify]);
  return { submit: (fields: Record<string, string>, options: { method: "post" }) => void fetcher.submit(fields, options) };
}

/**
 * Links to a long discussion's other pages, keeping the order the reader
 * chose; each lands at the comments.
 */
function PageLinks({ path, order, total, page, pages }: { path: string; order: CommentOrder; total: number; page: number; pages: number }) {
  const own = defaultOrder(total, useSettings().best_first_from);
  if (pages < 2) return null;
  const at = (number: number) => {
    const query = new URLSearchParams();
    if (order !== own) query.set("order", order);
    if (number > 1) query.set("page", String(number));
    const search = query.toString();
    return `${path}${search ? `?${search}` : ""}#comments-heading`;
  };
  return (
    <nav aria-label="Comment pages" className="flex flex-wrap items-center justify-between gap-2">
      {page > 1 ? (
        <Button asChild variant="ghost">
          <Link to={at(page - 1)}>Previous page</Link>
        </Button>
      ) : (
        <span />
      )}
      <span className="text-meta text-text-muted">
        Page {page} of {pages}
      </span>
      {page < pages ? (
        <Button asChild>
          <Link to={at(page + 1)}>Next page</Link>
        </Button>
      ) : (
        <span />
      )}
    </nav>
  );
}

/**
 * A link to a comment from before discussions had pages, `#c-<id>` alone,
 * whose comment is on another page: the address that opens that page.
 */
function useCommentOnAnotherPage(pages: number) {
  const navigate = useNavigate();
  // Every arrival, including a click within the open discussion.
  const { search, hash } = useLocation();
  useEffect(() => {
    const id = /^#c-([A-Za-z0-9_-]{1,32})$/.exec(hash)?.[1];
    if (!id || pages < 2 || document.getElementById(`c-${id}`)) return;
    const query = new URLSearchParams(search);
    // Asked for already: the comment is not in this discussion to find.
    if (query.get("c") === id) return;
    query.delete("page");
    query.set("c", id);
    void navigate(`?${query}#c-${id}`, { replace: true });
  }, [pages, search, hash, navigate]);
}

/**
 * A fresh page for each post. Another page or order of its discussion only
 * takes the viewer's votes and saves loaded with it: a comment being sent
 * keeps its box, which clears it once it is in, even when the comment
 * turns the discussion to best first.
 */
export default function Post(props: Route.ComponentProps) {
  return <PostView key={props.loaderData.id} {...props} />;
}

function PostView({ loaderData }: Route.ComponentProps) {
  const settings = useSettings();
  const participation = useParticipation(loaderData.marks, loaderData.now, `${loaderData.page}:${loaderData.order}`);
  const signIn = useSignIn();
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const live = loaderData.state === "live";
  const total = loaderData.total;
  const postId = loaderData.id;
  const path = loaderData.state === "live" ? loaderData.post.path : `/p/${postId}`;
  const viewerId = participation.viewer?.id;
  const closeReply = useCallback(() => setReplyingTo(null), []);
  const closeEditor = useCallback(() => setEditing(null), []);
  const own = (comment: CommentData) => viewerId !== undefined && comment.author?.id === viewerId;
  const admin = participation.viewer?.role === "admin" && !participation.viewer.ban;
  // Pinning a top-level comment: the post's author's side, unless a moderator pinned one; or an admin.
  const pinner = usePinning();
  const mayPin = (comment: CommentData): boolean => {
    const viewer = participation.viewer;
    if (loaderData.state !== "live" || !viewer || viewer.ban || comment.state !== "visible") return false;
    if (!loaderData.comments.some((top) => top.id === comment.id)) return false;
    if (admin) return true;
    const author = loaderData.post.author;
    const side = viewer.id === author.id || author.ownerId === viewer.id;
    return side && loaderData.pinned?.by !== "admin";
  };
  useCommentOnAnotherPage(loaderData.pages);

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
            {loaderData.pages > 1 ? (
              <span className="mr-auto text-meta text-text-muted">
                page {loaderData.page} of {loaderData.pages}
              </span>
            ) : null}
            {total > 1 ? <OrderSwitch path={path} order={loaderData.order} total={total} /> : null}
          </div>
          {live && loaderData.post.commentsClosed ? (
            <p className="text-meta text-text-muted">{CLOSED_RULE}</p>
          ) : live && total >= THREAD_MAX ? (
            <p className="text-meta text-text-muted">{COMMENT_REFUSAL.full}</p>
          ) : live ? (
            <CommentBox postId={postId} rule={commentRule(loaderData.post, participation.viewer, settings.good_karma)} />
          ) : null}
          {total > 0 ? (
            <div className="bleed rounded-xl border border-border bg-surface p-3 sm:p-4">
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
                      pin={
                        mayPin(comment)
                          ? {
                              pinned: comment.pinned !== undefined,
                              onSelect: () =>
                                pinner.submit(
                                  { intent: comment.pinned ? "unpin-comment" : "pin-comment", id: comment.id },
                                  { method: "post" },
                                ),
                            }
                          : undefined
                      }
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
                renderBadge={(comment) =>
                  comment.pinned ? (
                    <span
                      title={comment.pinned === "admin" ? "Pinned by a moderator" : "Pinned by the author"}
                      className="inline-flex items-center gap-1 text-meta font-medium text-accent"
                    >
                      <Pin size={12} aria-hidden />
                      Pinned
                    </span>
                  ) : null
                }
                renderAction={(comment) => (
                  <button
                    type="button"
                    aria-pressed={participation.isSaved(comment.id, "comment")}
                    aria-label={participation.isSaved(comment.id, "comment") ? "Remove comment from saved" : "Save comment"}
                    onClick={() => void participation.toggleSave(comment.id, "comment")}
                    className={cn(
                      "inline-flex size-8 items-center justify-center rounded-lg focus-visible:-outline-offset-2 pointer-coarse:size-(--touch)",
                      participation.isSaved(comment.id, "comment")
                        ? "text-accent hover:bg-accent-soft"
                        : "text-text-faint hover:bg-surface-2 hover:text-text",
                    )}
                  >
                    <Bookmark size={15} aria-hidden fill={participation.isSaved(comment.id, "comment") ? "currentColor" : "none"} />
                  </button>
                )}
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
          {loaderData.clipped ? (
            <p className="text-meta text-text-muted">
              Some of the newest replies on this page are left out: it holds more than one page shows.
            </p>
          ) : null}
          <PageLinks path={path} order={loaderData.order} total={total} page={loaderData.page} pages={loaderData.pages} />
        </section>
      </main>
    </MentionsProvider>
  );
}
