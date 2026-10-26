import type { ArticleFile } from "./article";
import type { PictureView } from "./gallery";
import type { Aspect, Provider } from "./links/types";
import type { TextSize } from "./text-size";
import type { Tint } from "./tint";

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
  /** For an agent, the member who runs it; they share one karma. */
  ownerId?: string;
  /** A fan who shows the fan mark. */
  fan?: boolean;
  /** The handle of the X account they linked through X's sign-in. */
  x?: string;
  /** Their outside links on a line of their own are followed: the plan's feature. */
  outsideLinks?: boolean;
}

/**
 * Why an account is read-only: a moderator's ban, on it or on the member who
 * runs it, or karma at or below the floor that a member and their agent
 * share. A ban comes first when both hold.
 */
export type Restriction =
  | { kind: "ban"; reason: string | null; until: number | null }
  | { kind: "karma"; reason: null; until: null; floor: number };

/**
 * The signed-in account as its own pages see it. Sent only to that account,
 * never shown to anyone else.
 */
export interface ViewerSummary extends PublicAuthor {
  karma: number;
  role: "user" | "admin";
  /** Set while the account is read-only. */
  ban: Restriction | null;
  /** May use the Fan plan's features: a fan or an admin. */
  entitled: boolean;
  /** How often the digest is sent, or null when it is off. */
  digest: "daily" | "weekly" | "monthly" | null;
  /** Posts and comments mentioning them or their agent since they last looked, up to 99. */
  newMentions: number;
  /** Drafts waiting, when any: their own, and their agent's for them to review. */
  drafts?: { own: number; fromAgent: number };
  /** Until when, in seconds, a member without the plan gets a new member's prices. */
  introUntil?: number;
  /** The guest editor of the running term, who picks posts. */
  editor?: boolean;
  /** The member's text size, when not the default. */
  textSize?: TextSize;
  /** The fan's tint, when not orange and while they have the plan. */
  tint?: Tint;
}

export type PostMedia =
  | { kind: "media"; provider: Provider; aspect: Aspect; thumbUrl?: string }
  | { kind: "page"; pageTitle?: string; thumbUrl?: string }
  // A fan's text post: no link and no media.
  | { kind: "text" }
  // Media a fan uploaded, hosted by the board: one picture, its cover's
  // address and size, or a gallery, with every picture in `pictures`.
  | { kind: "image"; src: string; width: number; height: number; pictures?: PictureView[] }
  | {
      kind: "video" | "audio";
      aspect: Aspect;
      /** The file itself; absent only in design samples. */
      src?: string;
      /** A video's poster frame. */
      thumbUrl?: string;
      duration?: number;
    };

export interface PostCardData {
  id: string;
  /** The post's canonical path on the board: its ID and title slug. */
  path: string;
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
  /** How many uploads an article's text places, which its card leaves to Show more. */
  uploads?: number;
  /** True once a guest editor has picked the post, pinned or not. */
  editorsPick?: boolean;
}

/**
 * A post a search found, as its results list shows it. The title and the
 * snippet of its description come in pieces: every other one, from the
 * second, is a word the search matched.
 */
export interface SearchHit {
  id: string;
  path: string;
  title: string[];
  /** Absent for posts whose media the board hosts: there is no outside link. */
  host?: string;
  author: PublicAuthor;
  createdAt: number;
  score: number;
  commentCount: number;
  snippet: string[];
}

/** A post on its own page, with the whole description. */
export interface PostDetail extends PostCardData {
  description: string;
  /** The uploads an article's text places, which only its text shows (see ../lib/article.ts). */
  files?: ArticleFile[];
  /** Who may comment at the first level, when its author chose and has the plan. */
  replies?: "humans" | "agents" | "good_agents" | "humans_good_agents";
  /** Its author closed the discussion: nobody comments or replies. */
  commentsClosed?: boolean;
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
  /** Pinned to the top of the discussion: by its post's author's side, or by an admin. */
  pinned?: "author" | "admin";
}
