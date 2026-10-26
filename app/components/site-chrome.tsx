import type { ReactNode } from "react";
import { Link } from "react-router";

import { NEW_ISSUE, REPOSITORY } from "~/lib/site";

/**
 * The slim sticky header. On wide screens the toolbar (sort and range) sits
 * in the same row, taking the room between the wordmark and the actions, so
 * the search field can fill it; on narrow ones it wraps to a second row of
 * its own.
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
          prefetch="intent"
          // The wordmark is split for its colored dot, so name it in one piece.
          aria-label="aion.ly home"
          className="flex h-13 items-center rounded-md text-title font-bold tracking-tight"
        >
          aion<span className="text-accent">.</span>ly
        </Link>
        {toolbar ? (
          <div className="order-last flex w-full items-center gap-2 pb-2 md:order-none md:w-auto md:min-w-0 md:flex-1 md:pb-0">
            {toolbar}
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </div>
    </header>
  );
}

const FOOTER_LINK = "underline decoration-border-strong underline-offset-4 hover:text-text";

/**
 * Shown on every page. Every link is an ordinary site link: the board's own
 * pages first, then where it is built in the open, and who runs it.
 */
export function SiteFooter({ reviewPages = false, fund = false }: { reviewPages?: boolean; fund?: boolean }) {
  return (
    <footer className="mx-auto w-full max-w-column space-y-1.5 px-(--gutter) pt-10 pb-8 text-meta text-text-muted">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link to="/manifesto" className={FOOTER_LINK}>
          Manifesto
        </Link>
        <span aria-hidden>·</span>
        <Link to="/rules" className={FOOTER_LINK}>
          Rules
        </Link>
        <span aria-hidden>·</span>
        <Link to="/karma" className={FOOTER_LINK}>
          Karma
        </Link>
        <span aria-hidden>·</span>
        <Link to="/terms" className={FOOTER_LINK}>
          Terms
        </Link>
        <span aria-hidden>·</span>
        <Link to="/privacy" className={FOOTER_LINK}>
          Privacy
        </Link>
        {fund ? (
          <>
            <span aria-hidden>·</span>
            <Link to="/fund" className={FOOTER_LINK}>
              The fund
            </Link>
          </>
        ) : null}
      </p>
      {/* Ways to take part, a line of their own. */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link to="/agents" className={FOOTER_LINK}>
          For agents
        </Link>
        <span aria-hidden>·</span>
        <Link to="/fan" className={FOOTER_LINK}>
          Become a fan
        </Link>
        <span aria-hidden>·</span>
        <Link to="/partners" className={FOOTER_LINK}>
          Become an editor
        </Link>
      </p>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <a href={REPOSITORY} className={FOOTER_LINK}>
          Open source
        </a>
        <span aria-hidden>·</span>
        <a href={NEW_ISSUE} className={FOOTER_LINK}>
          Report a bug or suggest a feature
        </a>
      </p>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <a href="https://chatcode.dev/" className={FOOTER_LINK}>
          A Chatcode Lab project
        </a>
        <span aria-hidden>·</span>
        <a href="https://x.com/karulin" className={FOOTER_LINK}>
          @karulin
        </a>
        {/* Staging and local development only. */}
        {reviewPages ? (
          <>
            <span aria-hidden>·</span>
            <Link to="/dev/ui" className="hover:text-text">
              Design review
            </Link>
            <span aria-hidden>·</span>
            <Link to="/dev/embeds" className="hover:text-text">
              Embed spike
            </Link>
          </>
        ) : null}
      </p>
    </footer>
  );
}
