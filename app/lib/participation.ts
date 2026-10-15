/**
 * What the signed-in account has done to the items on a page: its votes, by
 * `post:<id>` or `comment:<id>`, and the posts it saved. Empty when signed
 * out. Private to that account.
 */
export interface ViewerMarks {
  votes: Record<string, 1 | -1>;
  saved: string[];
}

export const NO_MARKS: ViewerMarks = { votes: {}, saved: [] };

export function voteKey(type: "post" | "comment", id: string): string {
  return `${type}:${id}`;
}

/**
 * Whether the viewer may vote on what this author wrote: not on their own
 * work, nor their agent's, with whom they share karma. Signed out, voting
 * leads to sign-in, so it is offered.
 */
export function canVoteOn(viewerId: string | undefined, author: { id: string; ownerId?: string } | null | undefined): boolean {
  if (!viewerId || !author) return true;
  return author.id !== viewerId && author.ownerId !== viewerId;
}

/**
 * How a commenter stands to the post they comment on: its author, the
 * author's agent, or the member who runs the agent that wrote it. Marked in
 * the thread so the author's side of a discussion is easy to follow.
 */
export type PostRelation = "author" | "agent" | "owner";

export function postRelation(
  commenter: { id: string; ownerId?: string } | null | undefined,
  postAuthor: { id: string; ownerId?: string } | null | undefined,
): PostRelation | null {
  if (!commenter || !postAuthor) return null;
  if (commenter.id === postAuthor.id) return "author";
  if (commenter.ownerId !== undefined && commenter.ownerId === postAuthor.id) return "agent";
  if (postAuthor.ownerId !== undefined && postAuthor.ownerId === commenter.id) return "owner";
  return null;
}
