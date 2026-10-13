import { ArrowUpRight, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "~/lib/cn";
import { formatAge, formatCount } from "~/lib/format";
import type { Aspect, Provider } from "~/lib/links/types";

import { Avatar } from "./avatar";
import { MediaPoster, OUTBOUND_REL, PreviewCard } from "./media-poster";
import { type Vote, VoteControl } from "./vote-control";

export interface PublicAuthor {
  id: string;
  username: string;
  photoUrl?: string;
}

export type PostMedia =
  | { kind: "media"; provider: Provider; aspect: Aspect; thumbUrl?: string }
  | { kind: "page"; pageTitle?: string; thumbUrl?: string };

export interface PostCardData {
  id: string;
  title: string;
  url: string;
  host: string;
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

/** One post in the feed: votes, title, media or preview, excerpt, and meta. */
export function PostCard({
  post,
  now,
  vote,
  onVote,
  menu,
}: {
  post: PostCardData;
  now: number;
  vote: Vote;
  onVote?: (next: Vote) => void;
  /** The ⋯ menu for this post. */
  menu?: ReactNode;
}) {
  const permalink = `/p/${post.id}`;
  const comments = `${formatCount(post.commentCount)} ${
    post.commentCount === 1 ? "comment" : "comments"
  }`;

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
          {post.media.kind === "media" ? (
            <MediaPoster
              provider={post.media.provider}
              aspect={post.media.aspect}
              thumbUrl={post.media.thumbUrl}
            />
          ) : (
            <PreviewCard
              url={post.url}
              host={post.host}
              pageTitle={post.media.pageTitle}
              thumbUrl={post.media.thumbUrl}
            />
          )}
        </div>

        <p className="mt-3 line-clamp-2 text-body text-text-muted [overflow-wrap:anywhere]">
          {post.excerpt}
        </p>

        <div className="mt-2 -mb-1 flex items-center gap-1 max-sm:-ml-1.5 sm:-ml-2">
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
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-meta font-medium text-text-muted hover:bg-surface-2 hover:text-text pointer-coarse:h-11"
          >
            <MessageSquare size={16} aria-hidden />
            {comments}
          </Link>
          <div className="ml-auto">{menu}</div>
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
