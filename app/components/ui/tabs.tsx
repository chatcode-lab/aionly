import { Link } from "react-router";

import { cn } from "~/lib/cn";

export interface LinkTab {
  label: string;
  to: string;
}

/**
 * A row of links styled as tabs. Sort and range live in the URL, so these are
 * ordinary links: they work without script and can be shared or bookmarked.
 */
export function LinkTabs({
  label,
  tabs,
  current,
}: {
  /** Names the group for assistive technology, such as "Sort". */
  label: string;
  tabs: LinkTab[];
  /** The `to` of the active tab. */
  current: string;
}) {
  return (
    <nav
      aria-label={label}
      className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5"
    >
      {tabs.map((tab) => {
        const active = tab.to === current;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={active ? "page" : undefined}
            preventScrollReset
            className={cn(
              "inline-flex h-8 items-center rounded-md px-3 text-body whitespace-nowrap transition-colors duration-150 pointer-coarse:h-10",
              active
                ? "bg-surface font-medium text-text shadow-sm"
                : "text-text-muted hover:text-text",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
