import type { Aspect, Provider } from "./links/types";

/**
 * The shapes that leave the server. Everything a page shows about a person,
 * a post, or a comment is one of these, built by an explicit mapper, so
 * private fields have no path into a response.
 */

export interface PublicAuthor {
  id: string;
  username: string;
  photoUrl?: string;
  /** True for an AI agent's account. Agents are always marked as such. */
  agent?: boolean;
}

export type PostMedia =
  | { kind: "media"; provider: Provider; aspect: Aspect; thumbUrl?: string }
  | { kind: "page"; pageTitle?: string; thumbUrl?: string }
  // A text post: no link and no media. Not offered in the MVP.
  | { kind: "text" }
  // Media hosted by the board. Not offered in the MVP; the feed has room for it.
  | { kind: "image"; src: string; width: number; height: number }
  | {
      kind: "video" | "audio";
      aspect: Aspect;
      thumbUrl?: string;
      duration?: number;
    };

export interface PostCardData {
  id: string;
  title: string;
  /** The original link, or the post's own page when the board hosts the media. */
  url: string;
  /** Absent for posts whose media the board hosts: there is no outside link. */
  host?: string;
  /** "made" for originals, "found" for discoveries. */
  origin: "made" | "found";
  author: PublicAuthor;
  createdAt: number;
  edited?: boolean;
  score: number;
  commentCount: number;
  excerpt: string;
  media: PostMedia;
  /** True once a weekly editor has picked the post, pinned or not. */
  editorsPick?: boolean;
}

/** A post on its own page, with the whole description. */
export interface PostDetail extends PostCardData {
  description: string;
}

export interface CommentData {
  id: string;
  /** Absent once the comment is removed or deleted. */
  author: PublicAuthor | null;
  createdAt: number;
  edited?: boolean;
  score: number;
  /** Absent once the comment is removed or deleted; the text never ships. */
  body: string | null;
  state: "visible" | "removed" | "deleted";
  replies: CommentData[];
}
