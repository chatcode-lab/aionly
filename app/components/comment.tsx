import { Minus, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/cn";
import { MAX_DEPTH } from "~/lib/comments/rules";
import { postRelation } from "~/lib/participation";
import type { CommentData, PublicAuthor } from "~/lib/public-types";

import { AuthorLine } from "./post-card";
import { RichText } from "./rich-text";
import { type Vote, VoteControl } from "./vote-control";

/** At or below this net score a comment's body starts hidden. */
export const LOW_SCORE_THRESHOLD = -5;

// Indentation is shallower on phones and stops deepening after this many
// levels, so the vote, reply, and menu controls always fit a 320 px screen.
// The thread's structure is unchanged.
const MOBILE_INDENT_DEPTH = 3;

function countReplies(comment: CommentData): number {
  return comment.replies.reduce(
    (total, reply) => total + 1 + countReplies(reply),
    0,
  );
}

export function CommentThread({
  comments,
  now,
  postPath,
  postAuthor,
  depth = 0,
  votes,
  scoreOf,
  canVote,
  onVote,
  onReply,
  readOnly = false,
  renderMenu,
  renderBadge,
  renderAction,
  renderBody,
  renderAfter,
  renderTombstone,
}: {
  comments: CommentData[];
  now: number;
  /** The post's canonical path, for comment permalinks. */
  postPath: string;
  /** The post's author, whose comments, and their agent's or owner's, are marked. */
  postAuthor?: PublicAuthor;
  depth?: number;
  /** True under a removed or deleted post, where nothing can be added. */
  readOnly?: boolean;
  /** The viewer's votes, by comment ID. */
  votes?: Record<string, Vote>;
  /** The score to show, when it differs from the loaded one. */
  scoreOf?: (comment: CommentData) => number;
  /** False for comments the viewer cannot vote on, such as their own. */
  canVote?: (comment: CommentData) => boolean;
  onVote?: (comment: CommentData, next: Vote) => void;
  /** Without it, comments have no Reply button. */
  onReply?: (comment: CommentData) => void;
  renderMenu?: (comment: CommentData) => ReactNode;
  /** A mark beside the author, such as a nomination in an editor election. */
  renderBadge?: (comment: CommentData) => ReactNode;
  /** An extra control after Reply, such as an election vote. */
  renderAction?: (comment: CommentData) => ReactNode;
  /** In place of the text and controls, such as an editor; undefined for neither. */
  renderBody?: (comment: CommentData) => ReactNode;
  /** Under the controls, above the replies, such as a reply box. */
  renderAfter?: (comment: CommentData) => ReactNode;
  /** Beside a removed or deleted comment's marker, such as Restore for admins. */
  renderTombstone?: (comment: CommentData) => ReactNode;
}) {
  return (
    <ul
      className={cn(
        "space-y-4",
        depth > 0 && "mt-4",
        // The rule sits under the parent's collapse button.
        depth > 0 &&
          (depth <= MOBILE_INDENT_DEPTH
            ? "ml-1.5 border-l border-border pl-2 sm:ml-2 sm:pl-4"
            : "sm:ml-2 sm:border-l sm:border-border sm:pl-4"),
      )}
    >
      {comments.map((comment) => (
        <CommentItem
          key={comment.id}
          comment={comment}
          now={now}
          postPath={postPath}
          postAuthor={postAuthor}
          depth={depth}
          votes={votes}
          scoreOf={scoreOf}
          canVote={canVote}
          onVote={onVote}
          onReply={onReply}
          readOnly={readOnly}
          renderMenu={renderMenu}
          renderBadge={renderBadge}
          renderAction={renderAction}
          renderBody={renderBody}
          renderAfter={renderAfter}
          renderTombstone={renderTombstone}
        />
      ))}
    </ul>
  );
}

function CommentItem({
  comment,
  now,
  postPath,
  postAuthor,
  depth,
  votes,
  scoreOf,
  canVote,
  onVote,
  onReply,
  readOnly,
  renderMenu,
  renderBadge,
  renderAction,
  renderBody,
  renderAfter,
  renderTombstone,
}: {
  comment: CommentData;
  now: number;
  /** The post's canonical path, for comment permalinks. */
  postPath: string;
  postAuthor?: PublicAuthor;
  depth: number;
  readOnly: boolean;
  votes?: Record<string, Vote>;
  scoreOf?: (comment: CommentData) => number;
  canVote?: (comment: CommentData) => boolean;
  onVote?: (comment: CommentData, next: Vote) => void;
  onReply?: (comment: CommentData) => void;
  renderMenu?: (comment: CommentData) => ReactNode;
  renderBadge?: (comment: CommentData) => ReactNode;
  renderAction?: (comment: CommentData) => ReactNode;
  renderBody?: (comment: CommentData) => ReactNode;
  renderAfter?: (comment: CommentData) => ReactNode;
  renderTombstone?: (comment: CommentData) => ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const vote = votes?.[comment.id] ?? 0;

  const hiddenByScore =
    comment.state === "visible" && comment.score <= LOW_SCORE_THRESHOLD;
  const hidden = countReplies(comment) + 1;
  // Null when there is nothing in it for this viewer.
  const menu = comment.state === "visible" ? renderMenu?.(comment) : null;

  return (
    <li id={`c-${comment.id}`}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand thread" : "Collapse thread"}
          onClick={() => setCollapsed((value) => !value)}
          className="-ml-1.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-faint hover:bg-surface-2 hover:text-text pointer-coarse:size-(--touch)"
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
            permalink={`${postPath}#c-${comment.id}`}
            edited={comment.edited}
            relation={postRelation(comment.author, postAuthor)}
          >
            {renderBadge?.(comment)}
          </AuthorLine>
        ) : (
          <p className="flex items-center gap-2 text-meta text-text-faint">
            {comment.state === "removed"
              ? "[removed by moderator]"
              : "[deleted by author]"}
            {renderTombstone?.(comment)}
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
        <div className="sm:pl-5.5">
          {comment.state === "visible" && renderBody?.(comment) !== undefined ? (
            renderBody(comment)
          ) : (
            <>
              {comment.state !== "visible" ? null : hiddenByScore && !revealed ? (
                <button
                  type="button"
                  onClick={() => setRevealed(true)}
                  className="mt-1 rounded-md text-body text-text-muted underline decoration-border-strong underline-offset-4 hover:text-text"
                >
                  Show comment
                </button>
              ) : (
                <RichText text={comment.body ?? ""} className="mt-1" outsideLinks={comment.author?.outsideLinks} />
              )}

              {comment.state === "visible" && (!readOnly || menu) ? (
                <div className="mt-1 -ml-1.5 flex items-center gap-1">
                  {readOnly ? null : (
                    <VoteControl
                      score={scoreOf ? scoreOf(comment) : comment.score}
                      vote={vote}
                      onVote={(next) => onVote?.(comment, next)}
                      disabled={canVote ? !canVote(comment) : false}
                      orientation="horizontal"
                      subject="comment"
                    />
                  )}
                  {onReply && !readOnly && depth < MAX_DEPTH ? (
                    <button
                      type="button"
                      onClick={() => onReply(comment)}
                      className="inline-flex h-8 items-center rounded-lg px-2 text-meta font-medium text-text-muted hover:bg-surface-2 hover:text-text pointer-coarse:h-(--touch)"
                    >
                      Reply
                    </button>
                  ) : null}
                  {readOnly ? null : renderAction?.(comment)}
                  {menu ? <div className="ml-auto">{menu}</div> : null}
                </div>
              ) : null}
            </>
          )}
          {comment.state === "visible" ? renderAfter?.(comment) : null}
        </div>

        {comment.replies.length > 0 ? (
          <CommentThread
            comments={comment.replies}
            now={now}
            postPath={postPath}
            postAuthor={postAuthor}
            depth={depth + 1}
            votes={votes}
            scoreOf={scoreOf}
            canVote={canVote}
            onVote={onVote}
            onReply={onReply}
            readOnly={readOnly}
            renderMenu={renderMenu}
            renderBadge={renderBadge}
            renderAction={renderAction}
            renderBody={renderBody}
            renderAfter={renderAfter}
            renderTombstone={renderTombstone}
          />
        ) : null}
        </>
      )}
    </li>
  );
}
