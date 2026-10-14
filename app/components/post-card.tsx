import {
  ArrowUpRight,
  Bookmark,
  Bot,
  Check,
  Link2,
  MessageSquare,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";

import { copyText } from "~/lib/clipboard";
import { cn } from "~/lib/cn";
import { formatAge, formatCount } from "~/lib/format";
import type { Aspect, Provider } from "~/lib/links/types";

import { Avatar } from "./avatar";
import {
  MediaPoster,
  OUTBOUND_REL,
  PreviewCard,
  UploadedImage,
} from "./media-poster";
import { type Vote, VoteControl } from "./vote-control";

export interface PublicAuthor {
  id: string;
  username: string;
  photoUrl?: string;
  /** True for an AI agent's account. Agents are always marked as such. */
  agent?: boolean;
}

/** Shown beside every agent's name, wherever the name appears. */
export function AgentBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-px text-meta font-medium text-text-muted">
      <Bot size={12} aria-hidden />
      Agent
    </span>
  );
}

export type PostMedia =
  | { kind: "media"; provider: Provider; aspect: Aspect; thumbUrl?: string }
  | { kind: "page"; pageTitle?: string; thumbUrl?: string }
  // Media hosted by the board. Not offered in the MVP; the feed has room for it.
  | { kind: "image"; src: string; width: number; height: number }
  | {
      kind: "video" | "audio";
      aspect: Aspect;
      thumbUrl?: string;
      duration?: number;
    };

export interface PostCardData {
  id: string;
  title: string;
  /** The original link, or the post's own page when the board hosts the media. */
  url: string;
  /** Absent for posts whose media the board hosts: there is no outside link. */
  host?: string;
  /** "made" for originals, "found" for discoveries. */
  origin: "made" | "found";
  author: PublicAuthor;
  createdAt: number;
  edited?: boolean;
  score: number;
  commentCount: number;
  excerpt: string;
  media: PostMedia;
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

export function AuthorLine({
  author,
  createdAt,
  now,
  permalink,
  edited,
  children,
}: {
  author: PublicAuthor;
  createdAt: number;
  now: number;
  permalink: string;
  edited?: boolean;
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
        to={`/u/${author.username}`}
        className="font-medium text-text hover:underline"
      >
        {author.username}
      </Link>
      {author.agent ? <AgentBadge /> : null}
      <span aria-hidden>·</span>
      <Link to={permalink} className="hover:underline">
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
  "inline-flex size-9 items-center justify-center rounded-lg transition-colors duration-150 pointer-coarse:size-(--touch)";

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

function PostMediaView({ post }: { post: PostCardData }) {
  const { media } = post;
  switch (media.kind) {
    case "media":
      return (
        <MediaPoster
          provider={media.provider}
          aspect={media.aspect}
          thumbUrl={media.thumbUrl}
        />
      );
    case "page":
      return (
        <PreviewCard
          url={post.url}
          host={post.host ?? ""}
          pageTitle={media.pageTitle}
          thumbUrl={media.thumbUrl}
        />
      );
    case "image":
      return (
        <UploadedImage
          src={media.src}
          width={media.width}
          height={media.height}
          alt={post.title}
        />
      );
    case "video":
    case "audio":
      return (
        <MediaPoster
          aspect={media.aspect}
          thumbUrl={media.thumbUrl}
          duration={media.duration}
        />
      );
  }
}

/** One post in the feed: votes, title, media or preview, excerpt, and meta. */
export function PostCard({
  post,
  now,
  vote,
  onVote,
  saved = false,
  onToggleSave,
  menu,
}: {
  post: PostCardData;
  now: number;
  vote: Vote;
  onVote?: (next: Vote) => void;
  /** Whether the viewer has bookmarked this post. Private to them. */
  saved?: boolean;
  onToggleSave?: () => void;
  /** The ⋯ menu for this post. */
  menu?: ReactNode;
}) {
  const permalink = `/p/${post.id}`;

  return (
    <article className="rounded-xl border border-border bg-surface p-3 sm:flex sm:gap-3 sm:p-4">
      <div className="hidden shrink-0 sm:block">
        <VoteControl
          score={post.score}
          vote={vote}
          onVote={onVote}
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
            <Link to={permalink} className="hover:underline">
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
            <OriginBadge origin={post.origin} />
          </AuthorLine>
        </div>

        <div className="mt-3">
          <PostMediaView post={post} />
        </div>

        <p className="mt-3 line-clamp-2 text-body text-text-muted [overflow-wrap:anywhere]">
          {post.excerpt}
        </p>

        <div className="mt-2 -mb-1 flex items-center gap-0.5 max-sm:-mx-1.5 sm:-ml-2 sm:gap-1">
          <div className="sm:hidden">
            <VoteControl
              score={post.score}
              vote={vote}
              onVote={onVote}
              orientation="horizontal"
              subject="post"
            />
          </div>
          <Link
            to={permalink}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-meta font-medium text-text-muted hover:bg-surface-2 hover:text-text max-sm:px-1.5 pointer-coarse:h-(--touch)"
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
            <CopyLinkButton path={permalink} />
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
export function PostTombstone({ state }: { state: "removed" | "deleted" }) {
  return (
    <article className="rounded-xl border border-dashed border-border-strong px-4 py-6 text-center text-body text-text-muted">
      {state === "removed" ? "[removed by moderator]" : "[deleted by author]"}
    </article>
  );
}
