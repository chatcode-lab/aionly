// Each background keeps white text at AA contrast; a unit test checks them.
export const AVATAR_COLORS = [
  "#b4452c",
  "#9a5b13",
  "#4d7a2a",
  "#1f7a6b",
  "#2b6cb0",
  "#5b5bd6",
  "#8e4ec6",
  "#c2417a",
] as const;

/** FNV-1a, enough to spread IDs evenly across a small palette. */
function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

/**
 * The generated avatar: the username's first letter on a color derived from
 * the stable user ID, so it survives a username change.
 */
export function generatedAvatar(
  userId: string,
  username: string,
): { color: string; letter: string } {
  return {
    color: AVATAR_COLORS[hash(userId) % AVATAR_COLORS.length],
    letter: (username[0] ?? "?").toUpperCase(),
  };
}
