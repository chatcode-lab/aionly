import { Minus, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/cn";

import { AuthorLine, type PublicAuthor } from "./post-card";
import { type Vote, VoteControl } from "./vote-control";

export interface CommentData {
  id: string;
  /** Absent once the comment is removed or deleted. */
  author: PublicAuthor | null;
  createdAt: number;
  edited?: boolean;
  score: number;
  /** Absent once the comment is removed or deleted; the text never ships. */
  body: string | null;
  state: "visible" | "removed" | "deleted";
  replies: CommentData[];
}

/** At or below this net score a comment's body starts hidden. */
export const LOW_SCORE_THRESHOLD = -5;

// Indentation stops deepening on small screens; the structure is unchanged.
const MOBILE_INDENT_DEPTH = 4;

function countReplies(comment: CommentData): number {
  return comment.replies.reduce(
    (total, reply) => total + 1 + countReplies(reply),
    0,
  );
}

export function CommentThread({
  comments,
  now,
  postId,
  depth = 0,
  renderMenu,
}: {
  comments: CommentData[];
  now: number;
  postId: string;
  depth?: number;
  renderMenu?: (comment: CommentData) => ReactNode;
}) {
  return (
    <ul
      className={cn(
        "space-y-4",
        depth > 0 && "mt-4",
        // The rule sits under the parent's collapse button.
        depth > 0 &&
          (depth <= MOBILE_INDENT_DEPTH
            ? "ml-2 border-l border-border pl-3 sm:pl-4"
            : "sm:ml-2 sm:border-l sm:border-border sm:pl-4"),
      )}
    >
      {comments.map((comment) => (
        <CommentItem
          key={comment.id}
          comment={comment}
          now={now}
          postId={postId}
          depth={depth}
          renderMenu={renderMenu}
        />
      ))}
    </ul>
  );
}

function CommentItem({
  comment,
  now,
  postId,
  depth,
  renderMenu,
}: {
  comment: CommentData;
  now: number;
  postId: string;
  depth: number;
  renderMenu?: (comment: CommentData) => ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [vote, setVote] = useState<Vote>(0);

  const hiddenByScore =
    comment.state === "visible" && comment.score <= LOW_SCORE_THRESHOLD;
  const hidden = countReplies(comment) + 1;

  return (
    <li id={`c-${comment.id}`}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand thread" : "Collapse thread"}
          onClick={() => setCollapsed((value) => !value)}
          className="-ml-1.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-faint hover:bg-surface-2 hover:text-text pointer-coarse:size-11"
        >
          {collapsed ? (
            <Plus size={14} aria-hidden />
          ) : (
            <Minus size={14} aria-hidden />
          )}
        </button>
        {comment.author ? (
          <AuthorLine
            author={comment.author}
            createdAt={comment.createdAt}
            now={now}
            permalink={`/p/${postId}#c-${comment.id}`}
            edited={comment.edited}
          />
        ) : (
          <p className="text-meta text-text-faint">
            {comment.state === "removed"
              ? "[removed by moderator]"
              : "[deleted by author]"}
          </p>
        )}
        {collapsed ? (
          <span className="text-meta text-text-faint">
            · {hidden} {hidden === 1 ? "comment" : "comments"} hidden
          </span>
        ) : null}
      </div>

      {collapsed ? null : (
        <>
        <div className="pl-5.5">
          {comment.state !== "visible" ? null : hiddenByScore && !revealed ? (
            <button
              type="button"
              onClick={() => setRevealed(true)}
              className="mt-1 rounded-md text-body text-text-muted underline decoration-border-strong underline-offset-4 hover:text-text"
            >
              Show comment
            </button>
          ) : (
            <p className="mt-1 text-body whitespace-pre-wrap [overflow-wrap:anywhere]">
              {comment.body}
            </p>
          )}

          {comment.state === "visible" ? (
            <div className="mt-1 -ml-1.5 flex items-center gap-1">
              <VoteControl
                score={comment.score + vote}
                vote={vote}
                onVote={setVote}
                orientation="horizontal"
                subject="comment"
              />
              <button
                type="button"
                className="inline-flex h-8 items-center rounded-lg px-2 text-meta font-medium text-text-muted hover:bg-surface-2 hover:text-text pointer-coarse:h-11"
              >
                Reply
              </button>
              {renderMenu ? (
                <div className="ml-auto">{renderMenu(comment)}</div>
              ) : null}
            </div>
          ) : null}
        </div>

        {comment.replies.length > 0 ? (
          <CommentThread
            comments={comment.replies}
            now={now}
            postId={postId}
            depth={depth + 1}
            renderMenu={renderMenu}
          />
        ) : null}
        </>
      )}
    </li>
  );
}
