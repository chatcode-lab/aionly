import type { CommentData } from "./public-types";
import { commentPath, profilePath } from "./slug";
import { plainLines } from "./text/markdown";
import { type MentionNames, replaceMentions } from "./text/mentions";

/**
 * Schema.org data for a post's page, as Google reads a discussion forum post:
 * https://developers.google.com/search/docs/appearance/structured-data/discussion-forum
 */
type Thing = Record<string, unknown>;

/**
 * The most comments a post page's data spells out; its `commentCount` counts
 * them all, as Google suggests when the markup holds only some.
 */
export const MARKED_UP_COMMENTS = 100;

/** Who wrote a post or comment: a person, or an agent as an organization. */
export function authorData(author: { username: string; agent?: boolean }, base: string): Thing {
  return {
    "@type": author.agent ? "Organization" : "Person",
    name: author.username,
    ...(author.username === "[deleted]" ? {} : { url: new URL(profilePath(author.username), base).href }),
  };
}

/** A post's or comment's net score as likes, never below none. */
export function likesData(score: number): Thing {
  return {
    "@type": "InteractionCounter",
    interactionType: "https://schema.org/LikeAction",
    userInteractionCount: Math.max(score, 0),
  };
}

/**
 * The comments a page of a discussion shows, in its order, each reply under
 * what it answers, with its whole text. A removed or deleted comment is there
 * only to hold the replies under it, marked Deleted, as on the page. Past
 * `max` comments, the rest are left out.
 */
export function commentsData(
  comments: CommentData[],
  postPath: string,
  base: string,
  mentions: MentionNames,
  max = MARKED_UP_COMMENTS,
): Thing[] {
  let left = max;
  const tree = (list: CommentData[]): Thing[] => {
    const marked: Thing[] = [];
    for (const comment of list) {
      if (left <= 0) break;
      left -= 1;
      const shared = {
        "@type": "Comment",
        url: new URL(commentPath(postPath, comment.id), base).href,
        datePublished: new Date(comment.createdAt * 1000).toISOString(),
      };
      if (comment.state === "visible" && comment.author) {
        const replies = tree(comment.replies);
        marked.push({
          ...shared,
          author: authorData(comment.author, base),
          text: replaceMentions(plainLines(comment.body ?? ""), mentions),
          interactionStatistic: likesData(comment.score),
          ...(replies.length > 0 ? { comment: replies } : {}),
        });
        continue;
      }
      const replies = tree(comment.replies);
      if (replies.length === 0) {
        left += 1;
        continue;
      }
      marked.push({
        ...shared,
        creativeWorkStatus: "Deleted",
        author: { "@type": "Person", name: "[deleted]" },
        text: comment.state === "removed" ? "[removed by moderator]" : "[deleted by author]",
        comment: replies,
      });
    }
    return marked;
  };
  return tree(comments);
}
