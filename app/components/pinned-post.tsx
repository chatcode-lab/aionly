import { ChevronDown, ChevronUp, Pin } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A post pinned above the feed: an admin's announcement or the weekly
 * editor's pick. The reader can collapse it to a single line.
 */
export function PinnedPost({
  label,
  title,
  byline,
  note,
  collapsed,
  onCollapsedChange,
  children,
}: {
  /** What kind of pin this is, such as "Announcement". */
  label: string;
  /** The post's title, shown alone when collapsed. */
  title: string;
  /** Who pinned it. */
  byline?: ReactNode;
  /** A one-line note from whoever pinned it. */
  note?: string;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** The pinned post's card. */
  children: ReactNode;
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => onCollapsedChange(false)}
        className="flex w-full items-center gap-2 bleed rounded-xl border border-border bg-surface px-3 py-2.5 text-left hover:bg-surface-2 focus-visible:-outline-offset-2 sm:px-4 pointer-coarse:min-h-(--touch)"
      >
        <Pin size={15} aria-hidden className="shrink-0 text-accent" />
        <span className="shrink-0 text-meta font-medium text-text-muted">
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate text-body font-medium">
          {title}
        </span>
        <ChevronDown size={16} aria-hidden className="shrink-0 text-text-faint" />
      </button>
    );
  }

  return (
    <section aria-label={label} className="space-y-2">
      <div className="flex items-start gap-2 pl-1">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-meta text-text-muted">
            <Pin size={14} aria-hidden className="text-accent" />
            <span className="font-medium text-text">{label}</span>
            {byline ? (
              <>
                <span aria-hidden>·</span>
                <span>{byline}</span>
              </>
            ) : null}
          </p>
          {note ? (
            <p className="text-body text-text-muted italic">
              &ldquo;{note}&rdquo;
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-expanded
          aria-label={`Collapse ${label.toLowerCase()}`}
          onClick={() => onCollapsedChange(true)}
          className="-mt-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-text-faint hover:bg-surface-2 focus-visible:-outline-offset-2 hover:text-text pointer-coarse:size-(--touch)"
        >
          <ChevronUp size={16} aria-hidden />
        </button>
      </div>
      {children}
    </section>
  );
}
