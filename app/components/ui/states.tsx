import { CircleAlert, Clock, Inbox, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/cn";

/** Placeholder with the same shape as a post card, so nothing shifts on load. */
export function PostCardSkeleton() {
  return (
    <div
      aria-hidden
      className="rounded-xl border border-border bg-surface p-3 sm:flex sm:gap-3 sm:p-4"
    >
      <div className="hidden w-10 shrink-0 flex-col items-center gap-2 sm:flex">
        <div className="skeleton size-8" />
        <div className="skeleton h-4 w-6" />
        <div className="skeleton size-8" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="skeleton h-5 w-3/4" />
        <div className="skeleton mt-2 h-4 w-1/3" />
        <div className="skeleton mt-3 aspect-video w-full rounded-xl" />
        <div className="skeleton mt-3 h-4 w-full" />
        <div className="skeleton mt-2 h-4 w-2/3" />
      </div>
    </div>
  );
}

function StateBlock({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
      <div className="text-text-faint">{icon}</div>
      <h2 className="mt-3 text-title font-semibold">{title}</h2>
      {children ? (
        <p className="mt-1 max-w-sm text-body text-text-muted">{children}</p>
      ) : null}
      {action ? <div className="mt-4 flex gap-2">{action}</div> : null}
    </div>
  );
}

export function EmptyState(props: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return <StateBlock icon={<Inbox size={28} aria-hidden />} {...props} />;
}

export function ErrorState(props: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div role="alert">
      <StateBlock icon={<TriangleAlert size={28} aria-hidden />} {...props} />
    </div>
  );
}

/** Marks a feature that is designed and visible but not switched on yet. */
export function SoonBadge() {
  return (
    <span className="rounded-md bg-surface-2 px-1.5 py-px text-meta font-medium text-text-muted">
      Soon
    </span>
  );
}

type NoticeTone = "info" | "wait" | "danger";

const NOTICE: Record<NoticeTone, { className: string; icon: ReactNode }> = {
  info: {
    className: "border-border bg-surface-2 text-text",
    icon: <CircleAlert size={18} aria-hidden />,
  },
  wait: {
    className: "border-border bg-surface-2 text-text",
    icon: <Clock size={18} aria-hidden />,
  },
  danger: {
    className: "border-danger bg-danger-soft text-danger",
    icon: <TriangleAlert size={18} aria-hidden />,
  },
};

/**
 * An inline message above a form or list: posting eligibility, a rate limit
 * with its retry time, or a ban notice.
 */
export function Notice({
  tone = "info",
  children,
}: {
  tone?: NoticeTone;
  children: ReactNode;
}) {
  const { className, icon } = NOTICE[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-body",
        className,
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
