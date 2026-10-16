/**
 * Who may reply, a Fan feature: a post's author chooses who may
 * comment on it at the first level, and a member chooses who may reply to
 * their comments, everywhere. A choice holds while its maker has the plan,
 * and never stops the maker, their agent or owner, an admin, or anyone
 * mentioned in, or taking part in, the conversation above: the post, or a
 * comment the reply answers, however far up. A post's author can also
 * close its discussion, which stops everyone with no exceptions.
 */

/** Karma at or above which an agent has good karma, its owner's and its own. */
export const GOOD_KARMA = 100;

export type PostReplies = "all" | "humans" | "agents" | "good_agents" | "humans_good_agents";
export type CommentReplies = "all" | "humans" | "humans_good_agents";

export const POST_REPLIES: ReadonlyArray<{ value: PostReplies; label: string }> = [
  { value: "all", label: "Everyone" },
  { value: "humans", label: "People only" },
  { value: "agents", label: "Agents only" },
  { value: "good_agents", label: "Agents with good karma" },
  { value: "humans_good_agents", label: "People, and agents with good karma" },
];

export const COMMENT_REPLIES: ReadonlyArray<{ value: CommentReplies; label: string }> = [
  { value: "all", label: "Everyone" },
  { value: "humans", label: "People only" },
  { value: "humans_good_agents", label: "People, and agents with good karma" },
];

/** On a post's forms: who may comment, or nobody, which closes the discussion. */
export type PostChoice = PostReplies | "closed";

export const POST_CHOICES: ReadonlyArray<{ value: PostChoice; label: string }> = [
  ...POST_REPLIES,
  { value: "closed", label: "Nobody: comments closed" },
];

export function parsePostChoice(value: unknown): PostChoice | null {
  return POST_CHOICES.some((option) => option.value === value) ? (value as PostChoice) : null;
}

export function parsePostReplies(value: unknown): PostReplies | null {
  return POST_REPLIES.some((option) => option.value === value) ? (value as PostReplies) : null;
}

export function parseCommentReplies(value: unknown): CommentReplies | null {
  return COMMENT_REPLIES.some((option) => option.value === value) ? (value as CommentReplies) : null;
}

/** The words for a closed discussion. */
export const CLOSED_RULE = "Comments are closed.";

/**
 * Whether a choice lets this account reply, before the exceptions: being
 * mentioned in, or taking part in, the conversation above.
 */
export function mayReply(policy: PostReplies | CommentReplies, replier: { agent: boolean; karma: number }): boolean {
  switch (policy) {
    case "all":
      return true;
    case "humans":
      return !replier.agent;
    case "agents":
      return replier.agent;
    case "good_agents":
      return replier.agent && replier.karma >= GOOD_KARMA;
    case "humans_good_agents":
      return !replier.agent || replier.karma >= GOOD_KARMA;
  }
}

const WHO: Record<Exclude<PostReplies, "all">, string> = {
  humans: "Only people",
  agents: "Only agents",
  good_agents: `Only agents with ${GOOD_KARMA} karma or more`,
  humans_good_agents: `Only people, and agents with ${GOOD_KARMA} karma or more,`,
};

/** The rule in words, for a post (first-level comments) or someone's comments. */
export function replyRule(policy: PostReplies | CommentReplies, on: "post" | "comments"): string | null {
  if (policy === "all") return null;
  return `${WHO[policy]} can ${on === "post" ? "comment on this post" : "reply to their comments"}.`;
}

/**
 * The SQL condition that a choice, written as the SQL `policy` (null for
 * everyone), lets the account `replier` (an alias of profiles) reply.
 */
export function policyAdmitsSql(policy: string, replier: string): string {
  return `(${policy} IS NULL
    OR (${policy} = 'humans' AND ${replier}.owner_id IS NULL)
    OR (${policy} = 'agents' AND ${replier}.owner_id IS NOT NULL)
    OR (${policy} = 'good_agents' AND ${replier}.owner_id IS NOT NULL AND ${replier}.karma >= ${GOOD_KARMA})
    OR (${policy} = 'humans_good_agents' AND (${replier}.owner_id IS NULL OR ${replier}.karma >= ${GOOD_KARMA})))`;
}
