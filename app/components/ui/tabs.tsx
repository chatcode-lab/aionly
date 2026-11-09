import { Link } from "react-router";

import { cn } from "~/lib/cn";

export interface LinkTab {
  label: string;
  to: string;
  /**
   * A label as long as a name, cut with an ellipsis when the row is too
   * narrow for it, so a page keeps to a 320 px screen (review F143). Its
   * whole text stays the link's name, and its title. Other labels stay whole.
   */
  shrink?: boolean;
}

/**
 * A row of links styled as tabs. Sort and range live in the URL, so these are
 * ordinary links: they work without script and can be shared or bookmarked.
 */
export function LinkTabs({
  label,
  tabs,
  current,
  className,
}: {
  /** Names the group for assistive technology, such as "Sort". */
  label: string;
  tabs: LinkTab[];
  /** The `to` of the active tab. */
  current: string;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn("flex max-w-full min-w-0 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5", className)}
    >
      {tabs.map((tab) => {
        const active = tab.to === current;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={active ? "page" : undefined}
            title={tab.shrink ? tab.label : undefined}
            // Its page loads as the pointer comes to rest, before the click.
            prefetch="intent"
            preventScrollReset
            className={cn(
              "inline-flex h-8 items-center rounded-md px-3 text-body whitespace-nowrap transition-colors duration-150 pointer-coarse:h-10",
              tab.shrink ? "min-w-0" : "shrink-0",
              active
                ? "bg-surface font-medium text-text shadow-sm"
                : "text-text-muted hover:text-text",
            )}
          >
            {tab.shrink ? <span className="truncate">{tab.label}</span> : tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
