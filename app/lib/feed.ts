export const SORTS = ["top", "new"] as const;
export type Sort = (typeof SORTS)[number];

export const RANGES = ["day", "week", "month", "all"] as const;
export type Range = (typeof RANGES)[number];

export const RANGE_LABEL: Record<Range, string> = {
  day: "Today",
  week: "Week",
  month: "Month",
  all: "All time",
};

export const PAGE_SIZE = 20;
/** The most post IDs a Top ranking snapshot holds. */
export const SNAPSHOT_LIMIT = 500;

/**
 * The sort the bare address opens on until a visitor picks one: New, while
 * the board has few votes to rank by (owner's request, 2026-10-24).
 */
export const DEFAULT_SORT: Sort = "new";

/** The cookie that keeps the sort a visitor last picked, for the bare address. */
export const SORT_COOKIE = "feed_sort";

export function parseSort(value: string | null | undefined): Sort | null {
  return SORTS.find((sort) => sort === value) ?? null;
}

export function parseRange(value: string | null): Range | null {
  return RANGES.find((range) => range === value) ?? null;
}

/**
 * The feed's address for a sort and range. The sort is always named, since
 * the bare address opens on the one the visitor last picked; a null range
 * means "whatever the board picks on arrival".
 */
export function feedPath(sort: Sort, range: Range | null): string {
  const params = new URLSearchParams({ sort });
  if (range) params.set("range", range);
  return `/?${params}`;
}
