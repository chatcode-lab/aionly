/** What the post page's action answers to each of its forms. */
export type AuthoringResult =
  | { ok: true; intent: AuthoringIntent; id?: string }
  | { ok: false; intent: AuthoringIntent; error: string };

export type AuthoringIntent = "comment" | "edit-comment" | "delete-comment" | "delete-post";

/** Where a draft comment is kept: one per post for the top box, one per reply. */
export function commentDraftKey(postId: string, parentId: string | null): string {
  return `comment:${postId}:${parentId ?? "top"}`;
}

/**
 * Brings a comment into view once it is on the page. False when it is not
 * on this page of the discussion, as a new top-level comment in a long one
 * may land on the last.
 */
export function revealComment(id: string): boolean {
  const element = document.getElementById(`c-${id}`);
  if (!element) return false;
  element.scrollIntoView({ block: "nearest" });
  window.history.replaceState(window.history.state, "", `#c-${id}`);
  return true;
}

/** The address of the page of this discussion holding the comment, in the order now shown. */
export function pageOfComment(search: string, id: string): string {
  const query = new URLSearchParams(search);
  query.delete("page");
  query.set("c", id);
  return `?${query}#c-${id}`;
}
