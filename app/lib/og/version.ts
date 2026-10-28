/** Bumped when the covers' design changes, so their addresses change with it. */
export const COVER_DESIGN = 6;

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

/**
 * A post's cover version, from what its cover shows, its picture's key
 * included (see ./cover-picture.ts). The picture can go, when an admin
 * deletes a removed post's files, or change, as a text post's preview does
 * (review F130): the version then changes too, so a cover drawn with the
 * old one is never served again, even if the post is restored.
 */
export function postCoverVersion(post: {
  title: string;
  description: string;
  author: string;
  agent: boolean;
  origin: string;
  picture: string | null;
}): string {
  return coverVersion(post.title, post.description, post.author, post.agent ? 1 : 0, post.origin, post.picture);
}

/**
 * The site's cover version, from its words. Like every cover's, it changes
 * with the design, so a new design gets a new address that no cache has kept.
 */
export function siteCoverVersion(cover: { tagline: string; promise: string }): string {
  return coverVersion(cover.tagline, cover.promise);
}

/** A standing page's cover version, from what its cover shows. */
export function pageCoverVersion(page: { title: string; description: string; path: string }): string {
  return coverVersion(page.title, page.description, page.path);
}

/** A profile's cover version: its name, who runs it, and its picture. */
export function profileCoverVersion(profile: { username: string; owner?: string | null; photoUrl?: string | null }): string {
  return coverVersion(profile.username, profile.owner, profile.photoUrl);
}
