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

export function parseSort(value: string | null): Sort {
  return SORTS.find((sort) => sort === value) ?? "top";
}

export function parseRange(value: string | null): Range | null {
  return RANGES.find((range) => range === value) ?? null;
}

/**
 * The feed's address for a sort and range. Top is the default sort and is
 * left out; a null range means "whatever the board picks on arrival".
 */
export function feedPath(sort: Sort, range: Range | null): string {
  const params = new URLSearchParams();
  if (sort !== "top") params.set("sort", sort);
  if (range) params.set("range", range);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}
