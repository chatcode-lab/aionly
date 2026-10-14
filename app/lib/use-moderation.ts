import { useRouteLoaderData } from "react-router";

export interface ModerationSummary {
  openReports: number;
  pinnedPostId: string | null;
}

/** For an admin, the queue's size and the pinned post; null for anyone else. */
export function useModeration(): ModerationSummary | null {
  const root = useRouteLoaderData("root") as { moderation?: ModerationSummary | null } | undefined;
  return root?.moderation ?? null;
}
