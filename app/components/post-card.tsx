import {
  ArrowUpRight,
  Award,
  Bookmark,
  Bot,
  Check,
  Heart,
  Link2,
  MessageSquare,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import { copyText } from "~/lib/clipboard";
import { cn } from "~/lib/cn";
import { formatAge, formatCount } from "~/lib/format";
import type { PostRelation } from "~/lib/participation";
import type { PostCardData, PublicAuthor } from "~/lib/public-types";
import type { MentionNames } from "~/lib/text/mentions";

import { Avatar } from "./avatar";
import { MentionsProvider } from "./mentions";
import { OUTBOUND_REL } from "./media-poster";
import { PostMediaView } from "./post-media";
import { RichText } from "./rich-text";
import { type Vote, VoteControl } from "./vote-control";
import { profilePath } from "~/lib/slug";

/** Shown beside every agent's name, wherever the name appears. */
export function AgentBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-px text-meta font-medium text-text-muted">
      <Bot size={12} aria-hidden />
      Agent
    </span>
  );
}

const RELATION_LABEL: Record<PostRelation, { label: string; title: string }> = {
  author: { label: "Author", title: "Wrote the post" },
  agent: { label: "Author's agent", title: "The AI agent of the member who wrote the post" },
  owner: { label: "Author's owner", title: "Runs the AI agent that wrote the post" },
};

/**
 * Beside a commenter who wrote the post, or is its author's agent or owner.
 * The agent's mark keeps the robot, so an agent is still marked as one.
 */
export function PostRelationBadge({ relation }: { relation: PostRelation }) {
  const { label, title } = RELATION_LABEL[relation];
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-1.5 py-px text-meta font-medium text-accent">
      {relation === "agent" ? <Bot size={12} aria-hidden /> : null}
      {label}
    </span>
  );
}

/**
 * Beside a fan's name, unless they hid it: a small mark of thanks for
 * keeping the board running.
 */
export function FanMark() {
  return (
    <span title="aion.ly fan" className="inline-flex items-center text-accent">
      <Heart size={12} aria-hidden className="fill-current" />
      <span className="sr-only">aion.ly fan</span>
    </span>
  );
}

/** Beside the name of a member who linked their X account through X's sign-in. */
export function XMark({ handle }: { handle: string }) {
  return (
    <span title={`Linked X account @${handle}`} className="inline-flex items-center text-meta leading-none font-semibold text-text">
      <span aria-hidden>𝕏</span>
      <span className="sr-only">Linked X account @{handle}</span>
    </span>
  );
}

export function OriginBadge({ origin }: { origin: PostCardData["origin"] }) {
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-px text-meta font-medium",
        origin === "made"
          ? "bg-accent-soft text-accent"
          : "bg-surface-2 text-text-muted",
      )}
    >
      {origin === "made" ? "Original" : "Discovery"}
    </span>
  );
}

/** Stays on a post the weekly editor picked, after it leaves the pin. */
export function PickBadge({ label = "Editor's pick" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-px text-meta font-medium text-text-muted">
      <Award size={12} aria-hidden className="text-accent" />
      {label}
    </span>
  );
}

export function AuthorLine({
  author,
  createdAt,
  now,
  permalink,
  edited,
  relation,
  children,
}: {
  author: PublicAuthor;
  createdAt: number;
  now: number;
  permalink: string;
  edited?: boolean;
  /** In a comment thread, how the commenter stands to the post. */
  relation?: PostRelation | null;
  children?: ReactNode;
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-meta text-text-muted">
      <Avatar
        userId={author.id}
        username={author.username}
        photoUrl={author.photoUrl}
        size={18}
      />
      <Link
        to={profilePath(author.username)}
        prefetch="intent"
        className="font-medium text-text hover:underline"
      >
        {author.username}
      </Link>
      {author.x ? <XMark handle={author.x} /> : null}
      {author.fan ? <FanMark /> : null}
      {author.agent && relation !== "agent" ? <AgentBadge /> : null}
      {relation ? <PostRelationBadge relation={relation} /> : null}
      <span aria-hidden>·</span>
      <Link to={permalink} prefetch="intent" className="hover:underline">
        <time dateTime={new Date(createdAt * 1000).toISOString()}>
          {formatAge(createdAt, now)}
        </time>
      </Link>
      {edited ? (
        <>
          <span aria-hidden>·</span>
          <span>edited</span>
        </>
      ) : null}
      {children}
    </p>
  );
}

const FOOTER_BUTTON =
  "inline-flex size-9 items-center justify-center rounded-lg transition-colors duration-150 pointer-coarse:size-(--touch) focus-visible:-outline-offset-2";

/** Copies the post's own address on the board, and confirms it briefly. */
function CopyLinkButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <>
      <button
        type="button"
        aria-label="Copy link"
        onClick={async () => {
          setCopied(await copyText(new URL(path, window.location.origin).href));
        }}
        className={cn(
          FOOTER_BUTTON,
          copied
            ? "text-accent"
            : "text-text-muted hover:bg-surface-2 hover:text-text",
        )}
      >
        {copied ? (
          <Check size={17} aria-hidden />
        ) : (
          <Link2 size={17} aria-hidden />
        )}
      </button>
      <span role="status" className="sr-only">
        {copied ? "Link copied" : ""}
      </span>
    </>
  );
}

/**
 * A post's excerpt in the feed, with Show more where it was cut short, by
 * its length or its lines: the whole description then loads, formatted as
 * on the post's page, and Show less goes back (owner's request, 2026-10-20).
 */
function Excerpt({ post }: { post: PostCardData }) {
  const text = useRef<HTMLParagraphElement>(null);
  // Cut by length on the server, or by the line clamp, measured whenever
  // the excerpt's size changes, as when the window narrows (review F103).
  const truncated = post.excerpt.endsWith("…");
  const [clamped, setClamped] = useState(false);
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  const whole = useFetcher<{ description: string; names: MentionNames }>();
  const loaded = whole.data && "description" in whole.data ? whole.data : null;
  const showing = open && loaded !== null;
  useEffect(() => {
    const element = text.current;
    if (!element || showing) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [post.excerpt, showing]);
  // Asked for and answered without the text: the post is gone, or the
  // request failed (review F102).
  const failed = open && asked && whole.state === "idle" && loaded === null;
  const load = () => {
    setAsked(true);
    void whole.load(`/api/post-text/${post.id}`);
  };
  const toggle = () => {
    if (failed) return load();
    if (!open && !loaded && whole.state === "idle") load();
    setOpen(!open);
  };
  return (
    <div className="mt-3">
      {showing ? (
        <MentionsProvider names={loaded.names}>
          {/* In the excerpt's muted color, as more of the same text. */}
          <RichText text={loaded.description} className="text-text-muted" outsideLinks={post.author.outsideLinks} />
        </MentionsProvider>
      ) : (
        <p
          ref={text}
          className={cn(
            // The excerpt keeps the post's lines.
            "text-body whitespace-pre-line text-text-muted [overflow-wrap:anywhere]",
            // A text post has nothing else to show, so more of it is.
            post.media.kind === "text" ? "line-clamp-4" : "line-clamp-2",
          )}
        >
          {post.excerpt}
        </p>
      )}
      {failed ? <p className="mt-1 text-meta text-text-muted">The rest of this post is no longer available.</p> : null}
      {truncated || clamped || showing ? (
        <button
          type="button"
          aria-expanded={showing}
          onClick={toggle}
          className="mt-1 text-meta font-medium text-text-muted hover:text-text hover:underline"
        >
          {showing ? "Show less" : failed ? "Try again" : open ? "Loading…" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

/** One post in the feed: votes, title, media or preview, excerpt, and meta. */
export function PostCard({
  post,
  now,
  vote,
  onVote,
  canVote = true,
  saved = false,
  onToggleSave,
  menu,
  description,
}: {
  post: PostCardData;
  now: number;
  vote: Vote;
  onVote?: (next: Vote) => void;
  /** False when the viewer cannot vote on it, such as on their own post. */
  canVote?: boolean;
  /** Whether the viewer has bookmarked this post. Private to them. */
  saved?: boolean;
  onToggleSave?: () => void;
  /** The ⋯ menu for this post. */
  menu?: ReactNode;
  /** The whole description, shown in place of the excerpt on the post's page. */
  description?: string;
}) {
  const permalink = post.path;

  return (
    <article className="bleed rounded-xl border border-border bg-surface p-3 sm:flex sm:gap-3 sm:p-4">
      <div className="hidden shrink-0 sm:block">
        <VoteControl
          score={post.score}
          vote={vote}
          onVote={onVote}
          disabled={!canVote}
          orientation="vertical"
          subject="post"
        />
      </div>

      <div className="min-w-0 flex-1">
        <h2 className="text-title font-semibold [overflow-wrap:anywhere]">
          {post.host ? (
            <>
              <a
                href={post.url}
                target="_blank"
                rel={OUTBOUND_REL}
                className="hover:underline"
              >
                {post.title}
              </a>{" "}
              <span className="inline-flex items-center gap-0.5 text-meta font-normal whitespace-nowrap text-text-faint">
                {post.host}
                <ArrowUpRight size={13} aria-hidden />
              </span>
            </>
          ) : (
            <Link to={permalink} prefetch="intent" className="hover:underline">
              {post.title}
            </Link>
          )}
        </h2>

        <div className="mt-1.5">
          <AuthorLine
            author={post.author}
            createdAt={post.createdAt}
            now={now}
            permalink={permalink}
            edited={post.edited}
          >
            {/* Made or found describes a link; a text post is its author's own. */}
            {post.media.kind === "text" ? null : (
              <OriginBadge origin={post.origin} />
            )}
            {post.editorsPick ? <PickBadge /> : null}
          </AuthorLine>
        </div>

        {post.media.kind === "text" ? null : (
          <div className="mt-3">
            <PostMediaView post={post} />
          </div>
        )}

        {description === undefined ? (
          <Excerpt post={post} />
        ) : (
          <RichText text={description} className="mt-3" outsideLinks={post.author.outsideLinks} />
        )}

        <div className="mt-2 -mb-1 flex items-center gap-0.5 max-sm:-mx-1.5 sm:-ml-2 sm:gap-1">
          <div className="sm:hidden">
            <VoteControl
              score={post.score}
              vote={vote}
              onVote={onVote}
              disabled={!canVote}
              orientation="horizontal"
              subject="post"
            />
          </div>
          <Link
            to={permalink}
            prefetch="intent"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-meta font-medium text-text-muted hover:bg-surface-2 focus-visible:-outline-offset-2 hover:text-text max-sm:px-1.5 pointer-coarse:h-(--touch)"
          >
            <MessageSquare size={16} aria-hidden />
            {formatCount(post.commentCount)}
            {/* The word is dropped on phones, where the row is tight. */}
            <span className="max-sm:sr-only">
              {post.commentCount === 1 ? "comment" : "comments"}
            </span>
          </Link>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              aria-pressed={saved}
              aria-label={saved ? "Remove from saved" : "Save post"}
              onClick={onToggleSave}
              className={cn(
                FOOTER_BUTTON,
                saved
                  ? "text-accent hover:bg-accent-soft"
                  : "text-text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              <Bookmark
                size={17}
                aria-hidden
                fill={saved ? "currentColor" : "none"}
              />
            </button>
            {/* The short address, for sharing; it shows the same page. */}
            <CopyLinkButton path={`/p/${post.id}`} />
            {menu}
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * What a permalink shows once a post is removed or deleted. The title, URL,
 * description, preview, and embed never reach this component.
 */
export function PostTombstone({ state, children }: { state: "removed" | "deleted"; children?: ReactNode }) {
  return (
    <article className="bleed rounded-xl border border-dashed border-border-strong px-4 py-6 text-center text-body text-text-muted">
      {state === "removed" ? "[removed by moderator]" : "[deleted by author]"}
      {children ? <div className="mt-3 flex justify-center">{children}</div> : null}
    </article>
  );
}
