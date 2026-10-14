/**
 * Mentions are stored as `<@user-id>`, a reference to the account rather
 * than its name, so a rename never breaks one. Pages show the current name.
 */
export const MENTION = /<@([A-Za-z0-9_-]{1,32})>/g;

/** How a mentioned account is shown: its current name, and whether an agent. */
export interface MentionName {
  username: string;
  agent: boolean;
  /** True once the account is deleted: shown, but not linked. */
  deleted?: boolean;
}

export type MentionNames = Record<string, MentionName>;

/** The account IDs mentioned in some text, without repeats. */
export function mentionIds(...texts: string[]): string[] {
  const ids = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(MENTION)) ids.add(match[1]!);
  }
  return [...ids];
}

/** Text with each mention written out by `format`; unknown ones as text. */
export function replaceMentions(
  text: string,
  names: MentionNames,
  format: (name: MentionName) => string = (name) => `@${name.username}`,
): string {
  return text.replace(MENTION, (token, id: string) => {
    const name = names[id];
    return name ? format(name) : token;
  });
}
