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

  it("asks everyone again for offers, and counts accounts at their floor as told, at 0023", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "", "0022_offer_emails.sql");
    db.exec(`
      INSERT INTO profiles (user_id, created_at, karma, vote_karma) VALUES ('low', 0, -120, -120), ('fresh', 0, -120, -120), ('fine', 0, 5, 5);
      UPDATE profiles SET karma_floor = -170 WHERE user_id = 'fresh';
    `);
    migrate(db, "0022_offer_emails.sql", "0023_consent_notices_returns.sql");
    const rows = db.prepare(`SELECT user_id, offers_consent_at, floor_emailed_at IS NOT NULL AS told FROM profiles ORDER BY user_id`).all();
    expect(rows).toEqual([
      { user_id: "fine", offers_consent_at: null, told: 0 },
      // Above a fresh start's own floor: not read-only, so not told.
      { user_id: "fresh", offers_consent_at: null, told: 0 },
      { user_id: "low", offers_consent_at: null, told: 1 },
    ]);
    const columns = db.prepare(`SELECT name FROM pragma_table_info('profiles')`).all().map((row) => (row as { name: string }).name);
    expect(columns).not.toContain("offers_email");
  });

  it("turns offers on for everyone but those who joined while offers needed a yes and gave none, at 0024", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "", "0023_consent_notices_returns.sql");
    db.exec(`
      INSERT INTO profiles (user_id, created_at, karma, vote_karma) VALUES ('yes', 0, 1, 1), ('none', 0, 1, 1);
      UPDATE profiles SET offers_consent_at = 5 WHERE user_id = 'yes';
    `);
    migrate(db, "0023_consent_notices_returns.sql", MIGRATIONS[MIGRATIONS.length - 1]!);
    const rows = db.prepare(`SELECT user_id, offers_off_at IS NULL AS offers FROM profiles ORDER BY user_id`).all();
    expect(rows).toEqual([
      { user_id: "none", offers: 0 },
      { user_id: "yes", offers: 1 },
    ]);
    // New profiles start with offers on.
    db.exec(`INSERT INTO profiles (user_id, created_at) VALUES ('new', 0)`);
    expect(db.prepare(`SELECT offers_off_at FROM profiles WHERE user_id = 'new'`).get()).toEqual({ offers_off_at: null });
    const columns = db.prepare(`SELECT name FROM pragma_table_info('profiles')`).all().map((row) => (row as { name: string }).name);
    expect(columns).not.toContain("offers_consent_at");
  });

  it("counts the paid fresh starts so far for the fund, at 0025", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "", "0024_offers_on.sql");
    db.exec(`
      INSERT INTO profiles (user_id, created_at) VALUES ('low', 0);
      INSERT INTO fresh_starts (id, user_id, source, created_at, applied_at) VALUES
        ('cs_paid', 'low', 'stripe', 10, 11), ('cs_declined', 'low', 'stripe', 20, NULL), ('act_free', 'low', 'admin', 30, 31);
    `);
    migrate(db, "0024_offers_on.sql", MIGRATIONS[MIGRATIONS.length - 1]!);
    expect(db.prepare(`SELECT id, kind, amount_cents, paid_at FROM payments`).all()).toEqual([
      { id: "cs_paid", kind: "fresh_start", amount_cents: 2000, paid_at: 11 },
    ]);
    expect(db.prepare(`SELECT show_gift FROM profiles`).get()).toEqual({ show_gift: 0 });
  });

  it("takes a declined draft's revision from its decline's record, so one changed in the same second still waits (review F95)", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "", "0041_tint.sql");
    db.exec(`
      INSERT INTO profiles (user_id, created_at) VALUES ('agent', 0);
      -- Each declined at revision 1: one unchanged since, one changed a second later, one in the same second.
      INSERT INTO drafts (id, author_id, kind, revision, created_at, updated_at, declined_at) VALUES
        ('unchanged', 'agent', 'text', 1, ${NOW - 100}, ${NOW - 50}, ${NOW - 50}),
        ('later', 'agent', 'text', 2, ${NOW - 100}, ${NOW - 49}, ${NOW - 50}),
        ('same', 'agent', 'text', 2, ${NOW - 100}, ${NOW - 50}, ${NOW - 50}),
        ('never', 'agent', 'text', 1, ${NOW - 100}, ${NOW - 100}, NULL);
      INSERT INTO agent_feedback (id, agent_id, action, target_type, target_id, revision, body, created_at) VALUES
        ('f1', 'agent', 'declined', 'draft', 'unchanged', 1, '', ${NOW - 50}),
        ('f2', 'agent', 'declined', 'draft', 'later', 1, '', ${NOW - 50}),
        ('f3', 'agent', 'declined', 'draft', 'same', 1, '', ${NOW - 50});
    `);
    migrate(db, "0041_tint.sql", MIGRATIONS[MIGRATIONS.length - 1]!);
    expect(
      db
        .prepare(`SELECT id, declined_revision, (declined_revision IS NULL OR revision > declined_revision) AS waiting FROM drafts ORDER BY id`)
        .all(),
    ).toEqual([
      { id: "later", declined_revision: 1, waiting: 1 },
      { id: "never", declined_revision: null, waiting: 1 },
      { id: "same", declined_revision: 1, waiting: 1 },
      { id: "unchanged", declined_revision: 1, waiting: 0 },
    ]);
  });

  it("records each declined draft's latest decline, the highest revision first, at 0048 (review F111)", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "", "0047_plan_switch.sql");
    db.exec(`
      INSERT INTO profiles (user_id, created_at) VALUES ('agent', 0);
      INSERT INTO drafts (id, author_id, kind, revision, created_at, updated_at, declined_at, declined_revision) VALUES
        ('twice', 'agent', 'text', 2, ${NOW - 100}, ${NOW - 40}, ${NOW - 40}, 2),
        ('never', 'agent', 'text', 1, ${NOW - 100}, ${NOW - 100}, NULL, NULL);
      INSERT INTO agent_feedback (id, agent_id, action, target_type, target_id, revision, explanation, body, created_at) VALUES
        ('zz_first', 'agent', 'declined', 'draft', 'twice', 1, 'On the first.', '', ${NOW - 40}),
        ('aa_second', 'agent', 'declined', 'draft', 'twice', 2, 'On the second.', '', ${NOW - 40});
    `);
    migrate(db, "0047_plan_switch.sql", MIGRATIONS[MIGRATIONS.length - 1]!);
    expect(db.prepare(`SELECT id, declined_feedback_id FROM drafts ORDER BY id`).all()).toEqual([
      { id: "never", declined_feedback_id: null },
      { id: "twice", declined_feedback_id: "aa_second" },
    ]);
  });

  it("queues the files the retired sweep still owed deleted accounts, and leaves every other post's (review F101)", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "", "0044_declined_revisions.sql");
    db.exec(`
      INSERT INTO profiles (user_id, created_at, deleted_at) VALUES ('gone', 0, ${NOW - 60}), ('here', 0, NULL);
      INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at) VALUES
        ('owed.png', 'gone', 'post', 'attached', 'image/png', 1, 0),
        ('kept_live.png', 'gone', 'post', 'attached', 'image/png', 1, 0),
        ('kept_removed.png', 'gone', 'post', 'attached', 'image/png', 1, 0),
        ('kept_author.png', 'here', 'post', 'attached', 'image/png', 1, 0);
      INSERT INTO posts (id, author_id, kind, url, canonical_key, title, description, origin, created_at, thumb_key, deleted_at, removed_batch_id) VALUES
        ('owed', 'gone', 'link', 'https://example.com/1', 'example.com/1', '', '', 'found', 0, 'owed.png', ${NOW - 60}, NULL),
        ('live', 'gone', 'link', 'https://example.com/2', 'example.com/2', 'A post', 'Kept.', 'found', 0, 'kept_live.png', NULL, NULL),
        ('removed', 'gone', 'link', 'https://example.com/3', 'example.com/3', 'A post', 'Kept.', 'found', 0, 'kept_removed.png', ${NOW - 60}, 'batch'),
        ('author', 'here', 'link', 'https://example.com/4', 'example.com/4', '', '', 'found', 0, 'kept_author.png', ${NOW - 60}, NULL);
    `);
    migrate(db, "0044_declined_revisions.sql", MIGRATIONS[MIGRATIONS.length - 1]!);
    expect(db.prepare(`SELECT key FROM file_deletions`).all()).toEqual([{ key: "owed.png" }]);
    expect(db.prepare(`SELECT key FROM images ORDER BY key`).all()).toEqual([{ key: "kept_author.png" }, { key: "kept_live.png" }, { key: "kept_removed.png" }]);
    expect(db.prepare(`SELECT id, thumb_key FROM posts ORDER BY id`).all()).toEqual([
      { id: "author", thumb_key: "kept_author.png" },
      { id: "live", thumb_key: "kept_live.png" },
      { id: "owed", thumb_key: null },
      { id: "removed", thumb_key: "kept_removed.png" },
    ]);
  });
});
