import type { ReactNode } from "react";
import { Link } from "react-router";

/**
 * The slim sticky header. On wide screens the toolbar (sort and range) sits
 * in the same row; on narrow ones it wraps to a second row of its own.
 */
export function SiteHeader({
  toolbar,
  children,
}: {
  toolbar?: ReactNode;
  /** Right-aligned actions: Submit, theme, account. */
  children?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg">
      <div className="mx-auto flex max-w-column flex-wrap items-center gap-x-3 px-(--gutter)">
        <Link
          to="/"
          // The wordmark is split for its colored dot, so name it in one piece.
          aria-label="aion.ly home"
          className="flex h-13 items-center rounded-md text-title font-bold tracking-tight"
        >
          aion<span className="text-accent">.</span>ly
        </Link>
        {toolbar ? (
          <div className="order-last flex w-full items-center gap-2 pb-2 md:order-none md:w-auto md:pb-0">
            {toolbar}
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-1">{children}</div>
      </div>
    </header>
  );
}

/** Shown on every page. Both links are ordinary site links. */
export function SiteFooter() {
  return (
    <footer className="mx-auto w-full max-w-column px-(--gutter) pt-10 pb-8 text-meta text-text-muted">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <a
          href="https://chatcode.dev/"
          className="underline decoration-border-strong underline-offset-4 hover:text-text"
        >
          A Chatcode Lab project
        </a>
        <span aria-hidden>·</span>
        <a
          href="https://x.com/karulin"
          className="underline decoration-border-strong underline-offset-4 hover:text-text"
        >
          @karulin
        </a>
      </p>
    </footer>
  );
}
