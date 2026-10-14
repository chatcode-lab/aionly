import { ArrowBigDown, ArrowBigUp } from "lucide-react";

import { cn } from "~/lib/cn";
import { formatCount } from "~/lib/format";

export type Vote = -1 | 0 | 1;

const BUTTON =
  "inline-flex size-8 items-center justify-center rounded-lg transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-(--touch)";

/**
 * Up and down votes around the net score. Pressing the active direction
 * again clears the vote. Vertical beside a card on desktop, horizontal in the
 * card footer on mobile.
 */
export function VoteControl({
  score,
  vote,
  orientation,
  onVote,
  disabled = false,
  subject,
}: {
  score: number;
  vote: Vote;
  orientation: "vertical" | "horizontal";
  onVote?: (next: Vote) => void;
  disabled?: boolean;
  /** What is being voted on, for button labels: "post" or "comment". */
  subject: string;
}) {
  return (
    <div
      role="group"
      aria-label={`Vote on this ${subject}`}
      className={cn(
        "flex items-center",
        orientation === "vertical" ? "flex-col gap-0.5" : "gap-0.5",
      )}
    >
      <button
        type="button"
        aria-label="Upvote"
        aria-pressed={vote === 1}
        disabled={disabled}
        onClick={() => onVote?.(vote === 1 ? 0 : 1)}
        className={cn(
          BUTTON,
          vote === 1
            ? "bg-accent-soft text-accent"
            : "text-text-faint hover:bg-surface-2 hover:text-text",
        )}
      >
        <ArrowBigUp
          size={20}
          aria-hidden
          fill={vote === 1 ? "currentColor" : "none"}
        />
      </button>
      <span
        aria-label={`${score} points`}
        className={cn(
          "min-w-6 text-center text-meta font-semibold tabular-nums",
          vote === 1 && "text-accent",
          vote === -1 && "text-down",
          vote === 0 && "text-text-muted",
        )}
      >
        {formatCount(score)}
      </span>
      <button
        type="button"
        aria-label="Downvote"
        aria-pressed={vote === -1}
        disabled={disabled}
        onClick={() => onVote?.(vote === -1 ? 0 : -1)}
        className={cn(
          BUTTON,
          vote === -1
            ? "bg-down-soft text-down"
            : "text-text-faint hover:bg-surface-2 hover:text-text",
        )}
      >
        <ArrowBigDown
          size={20}
          aria-hidden
          fill={vote === -1 ? "currentColor" : "none"}
        />
      </button>
    </div>
  );
}
