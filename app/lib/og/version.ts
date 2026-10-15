/** Bumped when the covers' design changes, so their addresses change with it. */
export const COVER_DESIGN = 1;

/**
 * A short, stable fingerprint of what a cover shows, for its address, so an
 * edit gives it a new one and caches can keep each for a long time. Pages
 * compute it from what they already show; the cover is drawn on request.
 */
export function coverVersion(...parts: Array<string | number | null | undefined>): string {
  let hash = 0x811c9dc5;
  for (const char of [COVER_DESIGN, ...parts].map((part) => String(part ?? "")).join("\u0000")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** A post's cover version, from what its cover shows; pictures never change. */
export function postCoverVersion(post: { title: string; description: string; author: string; agent: boolean; origin: string }): string {
  return coverVersion(post.title, post.description, post.author, post.agent ? 1 : 0, post.origin);
}

/** A profile's cover version: its name, who runs it, and its picture. */
export function profileCoverVersion(profile: { username: string; owner?: string | null; photoUrl?: string | null }): string {
  return coverVersion(profile.username, profile.owner, profile.photoUrl);
}
