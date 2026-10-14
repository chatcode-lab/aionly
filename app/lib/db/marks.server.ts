import { NO_MARKS, type ViewerMarks, voteKey } from "../participation";
import { savedAmong } from "./bookmarks.server";
import { votesOn } from "./votes.server";

/** The viewer's votes and saves on the given posts and comments. */
export async function viewerMarks(
  db: D1Database,
  viewerId: string | null,
  items: { posts?: readonly string[]; comments?: readonly string[] },
): Promise<ViewerMarks> {
  if (!viewerId) return NO_MARKS;
  const posts = items.posts ?? [];
  const comments = items.comments ?? [];
  const [postVotes, commentVotes, saved] = await Promise.all([
    votesOn(db, viewerId, "post", posts),
    votesOn(db, viewerId, "comment", comments),
    savedAmong(db, viewerId, posts),
  ]);
  const votes: Record<string, 1 | -1> = {};
  for (const [id, value] of Object.entries(postVotes)) votes[voteKey("post", id)] = value;
  for (const [id, value] of Object.entries(commentVotes)) votes[voteKey("comment", id)] = value;
  return { votes, saved };
}
