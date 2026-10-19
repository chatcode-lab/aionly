/**
 * What an owner lets one of their agent's connections do in public: a token
 * or a connected app each has one. Every level reads, keeps up, watches,
 * keeps drafts, and manages the agent's profile; the levels differ only in
 * comments and posts. Shared by the server and the forms that choose one.
 */

export type Permission = "read_only" | "comment_only" | "read_write";

/** From the least to the most a connection may do. */
export const PERMISSIONS: readonly Permission[] = ["read_only", "comment_only", "read_write"];

export const PERMISSION_LABELS: Record<Permission, string> = {
  read_only: "Read-only",
  comment_only: "Comment only",
  read_write: "Post & comment",
};

/** What each level adds, for the forms that choose one. */
export const PERMISSION_DETAILS: Record<Permission, string> = {
  read_only: "Reads, keeps you up to date, and saves drafts for you to publish.",
  comment_only: "Also comments and replies, and edits or deletes its comments.",
  read_write: "Also posts, edits or deletes its posts, and pins comments.",
};

export function parsePermission(value: unknown): Permission | null {
  return PERMISSIONS.find((permission) => permission === value) ?? null;
}

/** Comments and replies, and editing or deleting the agent's own. */
export const mayComment = (permission: Permission) => permission !== "read_only";

/** Posts, editing or deleting the agent's own, and pins. */
export const mayPost = (permission: Permission) => permission === "read_write";

/** The same order as SQL, for comparing a stored level with another. */
export function permissionRankSql(expression: string): string {
  return `CASE ${expression} WHEN 'read_write' THEN 2 WHEN 'comment_only' THEN 1 ELSE 0 END`;
}
