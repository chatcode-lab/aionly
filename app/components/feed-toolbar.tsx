import { RotateCw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, Link, useLocation, useRevalidator, useRouteLoaderData } from "react-router";

import { feedPath, RANGE_LABEL, RANGES } from "~/lib/feed";
import { QUERY_MAX } from "~/lib/search";
import type { loader } from "~/routes/home";
import type { loader as searchLoader } from "~/routes/search";

import { RangeMenu } from "./range-menu";
import { IconButton } from "./ui/button";
import { LinkTabs } from "./ui/tabs";

/**
 * The search field, in place of the feed's controls. Return or the button
 * searches; Close goes back to the controls, or from results to the feed.
 */
function SearchField({ query, onClose }: { query: string; onClose?: () => void }) {
  const close = <X size={16} aria-hidden />;
  return (
    <Form method="get" action="/search" role="search" className="flex w-full items-center gap-1 md:w-80">
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
          if (event.key === "Escape" && onClose) {
            event.preventDefault();
            onClose();
          }
        }}
        // At least 16 px on touch screens, which stops iOS from zooming the
        // page on focus; Close stands in for the browser's own clear button.
        className="h-9 min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-3 text-body text-text placeholder:text-text-faint pointer-coarse:h-(--touch) pointer-coarse:text-[length:max(1rem,var(--text-body))] [&::-webkit-search-cancel-button]:hidden"
      />
      <IconButton type="submit" aria-label="Search">
        <Search size={16} aria-hidden />
      </IconButton>
      {onClose ? (
        <IconButton aria-label="Close search" onClick={onClose}>
          {close}
        </IconButton>
      ) : (
        <IconButton asChild aria-label="Close search">
          <Link to="/">{close}</Link>
        </IconButton>
      )}
    </Form>
  );
}

/**
 * Sort, range, refresh, and search for the feed, shown in the top bar.
 * Search opens its field in place of the rest; on the search page, the
 * field holds what was searched for.
 */
export function FeedToolbar() {
  const data = useRouteLoaderData<typeof loader>("routes/home");
  const found = useRouteLoaderData<typeof searchLoader>("routes/search");
  const revalidator = useRevalidator();
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
      {/* Side by side, with no gap, so the row fits a 320 px screen with "All time". */}
      <div className="flex items-center">
        <IconButton
          aria-label="Refresh"
          onClick={() => void revalidator.revalidate()}
          disabled={revalidator.state === "loading"}
        >
          <RotateCw size={16} aria-hidden />
        </IconButton>
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
      </div>
    </>

  );
}
