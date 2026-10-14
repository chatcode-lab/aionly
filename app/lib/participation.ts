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
