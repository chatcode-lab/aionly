import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const DIRECTORY = new URL("../../migrations/", import.meta.url);
const MIGRATIONS = readdirSync(DIRECTORY)
  .filter((name) => name.endsWith(".sql"))
  .sort();

/** Applies the migrations after `after` (by file name) up to and including `last`. */
function migrate(db: DatabaseSync, after: string, last: string) {
  for (const name of MIGRATIONS) {
    if (name > after && name <= last) db.exec(readFileSync(new URL(name, DIRECTORY), "utf8"));
  }
}

const NOW = 1_800_000_000;

describe("upgrading a database with data in it", () => {
  it("keeps a sign-up's invitation claimed by email before 0016 for the account it made, and frees the rest", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "", "0015_claim_owners.sql");
    db.exec(`
      INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('joined', 'J', 'joined@example.invalid', 1, 0, 0);
      INSERT INTO profiles (user_id, created_at) VALUES ('host', 0), ('joined', 0);
      -- The account was made, but its invitation never attached; it also held a second, later claim.
      INSERT INTO invites (code, inviter_id, created_at, expires_at, claimed_email, claimed_at) VALUES
        ('OLDCODEFIRST0001', 'host', ${NOW - 100}, ${NOW + 1000}, 'joined@example.invalid', ${NOW - 50}),
        ('OLDCODESECOND002', 'host', ${NOW - 100}, ${NOW + 1000}, 'joined@example.invalid', ${NOW - 40}),
        -- A claim whose sign-up never made an account, and a code never claimed.
        ('OLDCODENOBODY003', 'host', ${NOW - 100}, ${NOW + 1000}, 'gone@example.invalid', ${NOW - 30}),
        ('OLDCODEOPEN00004', 'host', ${NOW - 100}, ${NOW + 1000}, NULL, NULL);
    `);
    migrate(db, "0015_claim_owners.sql", MIGRATIONS[MIGRATIONS.length - 1]!);
    const rows = db.prepare(`SELECT code, claimed_by, claimed_at IS NOT NULL AS claimed, revoked_at IS NOT NULL AS revoked FROM invites ORDER BY code`).all();
    expect(rows).toEqual([
      // Kept for the account it made, and not revoked, so recovery can attach it.
      { code: "OLDCODEFIRST0001", claimed_by: "joined", claimed: 1, revoked: 0 },
      { code: "OLDCODENOBODY003", claimed_by: null, claimed: 0, revoked: 1 },
      { code: "OLDCODEOPEN00004", claimed_by: null, claimed: 0, revoked: 1 },
      { code: "OLDCODESECOND002", claimed_by: null, claimed: 0, revoked: 1 },
    ]);
  });

  it("files existing comments under their top-level ones, and numbers existing mentions in order", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "", "0016_codes_mentions_and_x.sql");
    db.exec(`
      INSERT INTO profiles (user_id, created_at) VALUES ('u1', 0);
      INSERT INTO posts (id, author_id, kind, url, canonical_key, title, description, origin, created_at)
        VALUES ('p1', 'u1', 'link', 'https://example.com', 'example.com', 'A post', 'Something to read.', 'found', 0);
      INSERT INTO comments (id, post_id, parent_id, author_id, body, depth, created_at) VALUES
        ('top', 'p1', NULL, 'u1', 'Top', 0, 1), ('reply', 'p1', 'top', 'u1', 'Reply', 1, 2), ('deep', 'p1', 'reply', 'u1', 'Deep', 2, 3);
      INSERT INTO mentions (target_id, item_type, item_id, created_at) VALUES ('u1', 'comment', 'reply', ${NOW - 20}), ('u1', 'comment', 'deep', ${NOW - 5});
      UPDATE profiles SET mentions_seen_at = ${NOW - 10};
    `);
    migrate(db, "0016_codes_mentions_and_x.sql", MIGRATIONS[MIGRATIONS.length - 1]!);
    expect(db.prepare(`SELECT id, root_id FROM comments ORDER BY id`).all()).toEqual([
      { id: "deep", root_id: "top" },
      { id: "reply", root_id: "top" },
      { id: "top", root_id: "top" },
    ]);
    expect(db.prepare(`SELECT item_id, seq FROM mentions ORDER BY seq`).all()).toEqual([
      { item_id: "reply", seq: 1 },
      { item_id: "deep", seq: 2 },
    ]);
    // What the member had seen by time is what they have seen in the order: the later mention is still new.
    expect(db.prepare(`SELECT mentions_seen_seq FROM profiles`).get()).toEqual({ mentions_seen_seq: 1 });
    expect(db.prepare(`SELECT value FROM counters WHERE name = 'mentions'`).get()).toEqual({ value: 2 });
  });
});
