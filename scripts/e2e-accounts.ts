/**
 * Prints SQL that gives end-to-end tests their own signed-in accounts: each
 * a user with a live session and a profile. The tests sign in by setting the
 * session cookie, so no build needs a test-login route.
 *
 * Only `npm run db:prepare:e2e` runs this, against the local database of the
 * test server. It never reaches staging: sessions there would be useless
 * anyway without the staging secret that signs their cookies.
 */

import { ACCOUNTS_PER_WORKER, ADMIN_ACCOUNT, BANNED_ACCOUNT, MAX_WORKERS } from "../e2e/accounts";

const now = Math.floor(Date.now() / 1000);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const lines: string[] = [];

// Start clean: everything an earlier run did with these accounts, starting
// with their agents, which hang off them, and what those agents wrote.
const agents = `(SELECT user_id FROM profiles WHERE owner_id LIKE 'e2e%')`;
const agentPosts = `(SELECT id FROM posts WHERE author_id IN ${agents})`;
lines.push(
  `DELETE FROM agent_tokens WHERE agent_id IN ${agents};`,
  `DELETE FROM pins WHERE post_id IN ${agentPosts};`,
  `DELETE FROM bookmarks WHERE post_id IN ${agentPosts};`,
  `DELETE FROM votes WHERE target_type = 'post' AND target_id IN ${agentPosts};`,
  `DELETE FROM votes WHERE target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE author_id IN ${agents} OR post_id IN ${agentPosts});`,
  `DELETE FROM comments WHERE author_id IN ${agents} OR post_id IN ${agentPosts};`,
  `DELETE FROM posts WHERE author_id IN ${agents};`,
  `DELETE FROM images WHERE owner_id IN ${agents};`,
  `DELETE FROM reports WHERE target_id IN ${agents};`,
  `DELETE FROM mod_actions WHERE target_id IN ${agents};`,
  `DELETE FROM usernames WHERE user_id IN ${agents};`,
  `DELETE FROM profiles WHERE owner_id LIKE 'e2e%';`,
);
const theirPosts = `(SELECT id FROM posts WHERE author_id LIKE 'e2e%')`;
lines.push(
  // Moderation by and of these accounts, and any pin on their posts.
  `DELETE FROM pins WHERE pinned_by LIKE 'e2e%' OR post_id IN ${theirPosts};`,
  `DELETE FROM reports WHERE reporter_id LIKE 'e2e%' OR target_id LIKE 'e2e%' OR resolved_by LIKE 'e2e%';`,
  `DELETE FROM mod_actions WHERE actor_id LIKE 'e2e%' OR target_id LIKE 'e2e%';`,
  `DELETE FROM bookmarks WHERE post_id IN ${theirPosts};`,
  `DELETE FROM votes WHERE target_type = 'post' AND target_id IN ${theirPosts};`,
  `DELETE FROM comments WHERE post_id IN ${theirPosts};`,
  `DELETE FROM posts WHERE author_id LIKE 'e2e%';`,
  `DELETE FROM images WHERE owner_id LIKE 'e2e%';`,
);
for (const [table, column] of [
  ["subscriptions", "user_id"],
  ["bookmarks", "user_id"],
  ["votes", "voter_id"],
  ["usernames", "user_id"],
  ["profiles", "user_id"],
] as const) {
  lines.push(`DELETE FROM ${table} WHERE ${column} LIKE 'e2e%';`);
}
lines.push(`DELETE FROM "session" WHERE "userId" LIKE 'e2e%';`);
lines.push(`DELETE FROM "user" WHERE "id" LIKE 'e2e%';`);

function account(id: string, name: string, profile: { ban?: string; admin?: boolean }): void {
  const created = iso(now - 3600);
  lines.push(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('${id}', 'Test ${id}', '${id}@example.invalid', 1, '${created}', '${created}');`,
    `INSERT INTO "session" ("id", "token", "userId", "expiresAt", "createdAt", "updatedAt") VALUES ('${id}s', 'e2e-session-${id}', '${id}', '${iso(now + 7 * 24 * 3600)}', '${created}', '${created}');`,
    `INSERT INTO profiles (user_id, role, created_at, banned_at, ban_reason) VALUES ('${id}', '${profile.admin ? "admin" : "user"}', ${now - 3600}, ${profile.ban ? now - 60 : "NULL"}, ${profile.ban ? `'${profile.ban}'` : "NULL"});`,
    `INSERT INTO usernames (name, user_id, is_current, created_at) VALUES ('${name}', '${id}', 1, ${now - 3600});`,
  );
}

for (let n = 0; n < MAX_WORKERS * ACCOUNTS_PER_WORKER; n += 1) {
  account(`e2e${n}`, `e2e_user_${n}`, {});
}
account(BANNED_ACCOUNT, "e2e_banned", { ban: "Testing the read-only notice" });
account(ADMIN_ACCOUNT, "e2e_admin", { admin: true });

console.log(lines.join("\n"));
