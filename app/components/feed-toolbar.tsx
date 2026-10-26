import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, Link, useLocation, useNavigate, useRouteLoaderData } from "react-router";

import { feedPath, RANGE_LABEL, RANGES } from "~/lib/feed";
import { QUERY_MAX } from "~/lib/search";
import type { loader } from "~/routes/home";
import type { loader as searchLoader } from "~/routes/search";

import { RangeMenu } from "./range-menu";
import { IconButton } from "./ui/button";
import { LinkTabs } from "./ui/tabs";

/**
 * The search field, in place of the feed's controls, as wide as the bar
 * allows. Return searches, from a phone's keyboard too; Close, inside the
 * field, or Escape goes back to the controls, or from results to the feed
 * (review F131).
 */
function SearchField({ query, onClose }: { query: string; onClose?: () => void }) {
  const navigate = useNavigate();
  const close = <X size={16} aria-hidden />;
  // Inside the field, at its right end.
  const closeClass = "absolute inset-y-0 right-0";
  return (
    <Form method="get" action="/search" role="search" className="relative flex w-full items-center">
      <input
        // A new search from the results starts from what it searched for.
        key={query}
        type="search"
        name="q"
        defaultValue={query}
        aria-label="Search posts"
        placeholder="Search posts"
        maxLength={QUERY_MAX}
        enterKeyHint="search"
        autoComplete="off"
        // Opened to type in; over results, it waits.
        autoFocus={!query}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          if (onClose) onClose();
          else void navigate("/");
        }}
        // At least 16 px on touch screens, which stops iOS from zooming the
        // page on focus; Close stands in for the browser's own clear button,
        // with room kept for it.
        className="h-9 min-w-0 flex-1 rounded-lg border border-border-strong bg-surface pr-9 pl-3 text-body text-text placeholder:text-text-faint pointer-coarse:h-(--touch) pointer-coarse:pr-(--touch) pointer-coarse:text-[length:max(1rem,var(--text-body))] [&::-webkit-search-cancel-button]:hidden"
      />
      {onClose ? (
        <IconButton aria-label="Close search" onClick={onClose} className={closeClass}>
          {close}
        </IconButton>
      ) : (
        <IconButton asChild aria-label="Close search" className={closeClass}>
          <Link to="/">{close}</Link>
        </IconButton>
      )}
    </Form>
  );
}

/**
 * Sort, range, and search for the feed, shown in the top bar. Search opens
 * its field in place of the rest; on the search page, the field holds what
 * was searched for. There is no Refresh: loading the page again takes a new
 * ranking (owner's request, 2026-10-26).
 */
export function FeedToolbar() {
  const data = useRouteLoaderData<typeof loader>("routes/home");
  const found = useRouteLoaderData<typeof searchLoader>("routes/search");
  const location = useLocation();
  // Open over the feed until closed, or until the page changes.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === location.key;
  const searchLink = useRef<HTMLAnchorElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    searchLink.current?.focus();
  }, [open]);

  if (found) return <SearchField query={found.query} />;
  if (!data) return null;
  if (open) {
    return (
      <SearchField
        query=""
        onClose={() => {
          refocus.current = true;
          setOpenAt(null);
        }}
      />
    );
  }

  // Sort tabs keep a range only when the visitor picked one, so the board
  // still picks it otherwise.
  const picked = data.rangePicked ? data.range : null;

  return (
    <>
      <LinkTabs
        label="Sort"
        current={feedPath(data.sort, picked)}
        tabs={[
          { label: "Top", to: feedPath("top", picked) },
          { label: "New", to: feedPath("new", picked) },
        ]}
      />
      <RangeMenu
        current={feedPath(data.sort, data.range)}
        options={RANGES.map((range) => ({
          label: RANGE_LABEL[range],
          to: feedPath(data.sort, range),
        }))}
      />
      {/* The search page until the page's scripts run, then the field in place. */}
      <IconButton asChild aria-label="Search">
        <Link
          ref={searchLink}
          to="/search"
          onClick={(event) => {
            event.preventDefault();
            setOpenAt(location.key);
          }}
        >
          <Search size={16} aria-hidden />
        </Link>
      </IconButton>
    </>

  );
}
