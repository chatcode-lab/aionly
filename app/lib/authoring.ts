/** What the post page's action answers to each of its forms. */
export type AuthoringResult =
  | { ok: true; intent: AuthoringIntent; id?: string }
  | { ok: false; intent: AuthoringIntent; error: string };

export type AuthoringIntent = "comment" | "edit-comment" | "delete-comment" | "delete-post";

/** Where a draft comment is kept: one per post for the top box, one per reply. */
export function commentDraftKey(postId: string, parentId: string | null): string {
  return `comment:${postId}:${parentId ?? "top"}`;
}

/** Brings a comment into view once it is on the page. */
export function revealComment(id: string): void {
  const element = document.getElementById(`c-${id}`);
  if (!element) return;
  element.scrollIntoView({ block: "nearest" });
  window.history.replaceState(window.history.state, "", `#c-${id}`);
}
