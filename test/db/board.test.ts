import { beforeEach, describe, expect, it } from "vitest";

import {
  defaultRange,
  newPage,
  postsByIds,
  topSnapshot,
} from "../../app/lib/db/feed.server";
import { PAGE_SIZE } from "../../app/lib/feed";
import { PAGE_COMMENTS_MAX, postPage, ROOTS_PER_PAGE } from "../../app/lib/db/posts.server";
import { profileByName } from "../../app/lib/db/profiles.server";
import { comment, DAY, db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("u1", "quiet_otter_482", { karma: 12 });
  await user("u2", "paper_lark_17");
});

describe("defaultRange", () => {
  const posts = (count: number, age: number, prefix: string) =>
    Promise.all(
      Array.from({ length: count }, (_, n) => post(`${prefix}${n}`, { age })),
    );

  it("uses the week when it can fill a first screen", async () => {
    await posts(10, 2 * DAY, "w");
    expect(await defaultRange(db, NOW)).toBe("week");
  });

  it("widens to the month, then to all time, when the board is quiet", async () => {
    await posts(9, 2 * DAY, "w");
    expect(await defaultRange(db, NOW)).toBe("all");

    await posts(1, 20 * DAY, "m");
    expect(await defaultRange(db, NOW)).toBe("month");
  });

  it("does not count removed or deleted posts", async () => {
    await posts(9, 2 * DAY, "w");
    await post("gone1", { age: DAY, removed: true });
    await post("gone2", { age: DAY, deleted: true });
    expect(await defaultRange(db, NOW)).toBe("all");
  });

  it("falls back to all time on an empty board", async () => {
    expect(await defaultRange(db, NOW)).toBe("all");
  });
});

describe("topSnapshot", () => {
  it("orders by score, then newest, and leaves out removed and deleted posts", async () => {
    await post("low", { score: 1, age: 100 });
    await post("high", { score: 9, age: 500 });
    await post("tie_old", { score: 5, age: 900 });
    await post("tie_new", { score: 5, age: 200 });
    await post("removed", { score: 99, removed: true });
    await post("deleted", { score: 98, deleted: true });

    expect(await topSnapshot(db, "week", NOW)).toEqual([
      "high",
      "tie_new",
      "tie_old",
      "low",
    ]);
  });

  it("filters each range by publication time", async () => {
    await post("hours", { age: 3600 });
    await post("days", { age: 3 * DAY });
    await post("weeks", { age: 20 * DAY });
    await post("months", { age: 90 * DAY });
    // Exactly on the 24-hour boundary counts as today.
    await post("edge", { age: DAY });

    const ids = async (range: "day" | "week" | "month" | "all") =>
      (await topSnapshot(db, range, NOW)).sort();
    expect(await ids("day")).toEqual(["edge", "hours"]);
    expect(await ids("week")).toEqual(["days", "edge", "hours"]);
    expect(await ids("month")).toEqual(["days", "edge", "hours", "weeks"]);
    expect(await ids("all")).toEqual(["days", "edge", "hours", "months", "weeks"]);
  });
});

describe("Top pagination from a snapshot", () => {
  it("neither skips nor repeats posts when scores change between pages", async () => {
    for (let n = 0; n < 45; n += 1) {
      await post(`p${String(n).padStart(2, "0")}`, { score: n, age: 100 + n });
    }
    const snapshot = await topSnapshot(db, "week", NOW);
    expect(snapshot).toHaveLength(45);

    const firstPage = await postsByIds(db, snapshot.slice(0, PAGE_SIZE));

    // Votes land while the reader is on page one: an unseen post jumps to the
    // top, a seen one sinks, and another is removed.
    await db.batch([
      db.prepare(`UPDATE posts SET score = 1000 WHERE id = 'p03'`),
      db.prepare(`UPDATE posts SET score = -50 WHERE id = 'p44'`),
      db.prepare(`UPDATE posts SET removed_batch_id = 'b' WHERE id = 'p10'`),
    ]);

    const rest = [
      ...(await postsByIds(db, snapshot.slice(PAGE_SIZE, 2 * PAGE_SIZE))),
      ...(await postsByIds(db, snapshot.slice(2 * PAGE_SIZE))),
    ];
    const seen = [...firstPage, ...rest].map((card) => card.id);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(snapshot.filter((id) => id !== "p10"));
    // Cards carry current scores even though the order is the snapshot's.
    expect(rest.find((card) => card.id === "p03")?.score).toBe(1000);
  });

  it("ignores malformed IDs and loads at most one page per call", async () => {
    for (let n = 0; n < 25; n += 1) await post(`q${n}`);
    const ids = Array.from({ length: 25 }, (_, n) => `q${n}`);

    expect(await postsByIds(db, ids)).toHaveLength(PAGE_SIZE);
    expect(await postsByIds(db, ["q1", "'; DROP TABLE posts; --", "", "q2"])).toHaveLength(2);
    expect(await postsByIds(db, [])).toEqual([]);
  });
});

describe("newPage", () => {
  it("pages newest first with a stable cursor, without gaps or repeats", async () => {
    // Several posts share a timestamp, so ordering must fall back to the ID.
    for (let n = 0; n < 45; n += 1) {
      await post(`n${String(n).padStart(2, "0")}`, { age: 1000 + Math.floor(n / 3) });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await newPage(db, "week", NOW, cursor);
      seen.push(...page.posts.map((card) => card.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
    // n00 to n02 are the newest; within a timestamp, the higher ID comes first.
    expect(seen.slice(0, 3)).toEqual(["n02", "n01", "n00"]);
  });

  it("respects the range and treats a garbage cursor as the first page", async () => {
    await post("fresh", { age: 3600 });
    await post("stale", { age: 40 * DAY });

    expect((await newPage(db, "week", NOW, null)).posts.map((c) => c.id)).toEqual(["fresh"]);
    expect((await newPage(db, "all", NOW, "not-a-cursor")).posts.map((c) => c.id)).toEqual([
      "fresh",
      "stale",
    ]);
  });
});

describe("feed cards", () => {
  it("carry an excerpt, never the whole description", async () => {
    await post("long", { description: `${"word ".repeat(200)}SENTINEL_TAIL` });
    const [card] = await postsByIds(db, ["long"]);

    expect(card.excerpt.length).toBeLessThanOrEqual(280);
    expect(card.excerpt.endsWith("…")).toBe(true);
    expect(JSON.stringify(card)).not.toContain("SENTINEL_TAIL");
    expect(card).not.toHaveProperty("description");
  });

  it("describe media posts and page posts differently", async () => {
    await post("video", {
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      provider: "youtube",
      aspect: "16:9",
    });
    await post("page", { url: "https://www.example.com/tool" });
    const [video, page] = await postsByIds(db, ["video", "page"]);

    expect(video.media).toEqual({ kind: "media", provider: "youtube", aspect: "16:9", thumbUrl: undefined });
    expect(video.host).toBe("youtube.com");
    expect(page.media.kind).toBe("page");
    expect(page.host).toBe("example.com");
  });

  it("mark a post edited only past the grace period", async () => {
    await post("quick", { editedAfter: 120 });
    await post("later", { editedAfter: 3600 });
    const [quick, later] = await postsByIds(db, ["quick", "later"]);
    expect(quick.edited).toBe(false);
    expect(later.edited).toBe(true);
  });
});

describe("postPage", () => {
  it("returns a live post with its whole description", async () => {
    await post("p1", { description: "The whole description." });
    const page = await postPage(db, "p1");
    expect(page?.state).toBe("live");
    if (page?.state === "live") {
      expect(page.post.description).toBe("The whole description.");
      expect(page.post.author.username).toBe("quiet_otter_482");
    }
  });

  it("returns null for a post that does not exist", async () => {
    expect(await postPage(db, "missing")).toBeNull();
  });

  it.each([
    ["removed", { removed: true }],
    ["deleted", { deleted: true }],
    ["removed", { removed: true, deleted: true }],
  ] as const)("serves a %s post as a tombstone with nothing of the post in it", async (state, flags) => {
    await post("p1", {
      ...flags,
      title: "SENTINEL_TITLE",
      description: "SENTINEL_DESCRIPTION",
      url: "https://example.com/SENTINEL_URL",
    });
    await comment("c1", { body: "A comment that stays readable." });

    const page = await postPage(db, "p1");
    expect(page?.state).toBe(state);
    expect(JSON.stringify(page)).not.toContain("SENTINEL");
    expect(page?.comments).toHaveLength(1);
  });

  it("orders a discussion oldest first, best first, or newest first, replies alike", async () => {
    await post("p1");
    await comment("old_low", { score: 1, age: 900 });
    await comment("new_high", { score: 8, age: 100 });
    await comment("tie_newer", { score: 4, age: 200 });
    await comment("tie_older", { score: 4, age: 700 });
    await comment("reply_new", { parent: "old_low", depth: 1, score: 9, age: 50 });
    await comment("reply_old", { parent: "old_low", depth: 1, score: 0, age: 800 });

    const ids = async (order?: "old" | "best" | "new") => {
      const page = await postPage(db, "p1", order);
      return { order: page?.order, top: page?.comments.map((c) => c.id), replies: page?.comments.find((c) => c.id === "old_low")?.replies.map((c) => c.id) };
    };
    // A small discussion reads in order by default.
    expect(await ids()).toEqual({ order: "old", top: ["old_low", "tie_older", "tie_newer", "new_high"], replies: ["reply_old", "reply_new"] });
    expect(await ids("best")).toEqual({ order: "best", top: ["new_high", "tie_older", "tie_newer", "old_low"], replies: ["reply_new", "reply_old"] });
    expect(await ids("new")).toEqual({ order: "new", top: ["new_high", "tie_newer", "tie_older", "old_low"], replies: ["reply_new", "reply_old"] });
  });

  it("pages a long discussion by top-level comments, each with all its replies", async () => {
    await post("p1");
    const statements = [];
    // 120 top-level comments, oldest c000, each with a reply; c010 has a deep one.
    for (let index = 0; index < 120; index += 1) {
      const id = `c${String(index).padStart(3, "0")}`;
      statements.push(
        db.prepare(`INSERT INTO comments (id, post_id, author_id, body, score, created_at) VALUES (?1, 'p1', 'u1', 'Top', ?2, ?3)`).bind(id, index % 5, NOW - 10_000 + index),
        db.prepare(`INSERT INTO comments (id, post_id, parent_id, author_id, body, depth, created_at) VALUES (?1, 'p1', ?2, 'u1', 'Reply', 1, ?3)`).bind(`r${id}`, id, NOW - 5_000 + index),
      );
    }
    statements.push(db.prepare(`INSERT INTO comments (id, post_id, parent_id, author_id, body, depth, created_at) VALUES ('deep', 'p1', 'rc010', 'u1', 'Deep', 2, ?1)`).bind(NOW - 100));
    await db.batch(statements);
    // The database files each comment under its top-level one as it is written.
    expect(await db.prepare(`SELECT root_id FROM comments WHERE id = 'deep'`).first()).toEqual({ root_id: "c010" });

    const first = (await postPage(db, "p1", "old"))!;
    expect(first).toMatchObject({ page: 1, pages: 3, total: 241, clipped: false });
    expect(first.comments).toHaveLength(ROOTS_PER_PAGE);
    expect(first.comments[0]!.id).toBe("c000");
    expect(first.comments.find((c) => c.id === "c010")?.replies[0]?.replies[0]?.id).toBe("deep");
    const last = (await postPage(db, "p1", "old", { page: 3 }))!;
    expect(last.comments.map((c) => c.id)).toEqual(Array.from({ length: 20 }, (_, index) => `c${100 + index}`));
    expect(last.comments.every((c) => c.replies.length === 1)).toBe(true);
    // Past the end is the last page.
    expect((await postPage(db, "p1", "old", { page: 9 }))?.page).toBe(3);
    // A comment, or a reply deep in one, opens the page holding its top-level comment, in the order shown.
    expect((await postPage(db, "p1", "old", { focus: "c057" }))?.page).toBe(2);
    expect((await postPage(db, "p1", "new", { focus: "deep" }))?.page).toBe(3);
    expect((await postPage(db, "p1", "new", { focus: "c119" }))?.page).toBe(1);
    // Best first pages as it sorts: every page in score order, none repeated.
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const found = (await postPage(db, "p1", "best", { page }))!;
      seen.push(...found.comments.map((c) => c.id));
    }
    expect(new Set(seen).size).toBe(120);
    const scores = seen.map((id) => Number(id.slice(1)) % 5);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("leaves out the newest replies of a page that holds more than it loads, keeping every reply's parent", async () => {
    await post("p1");
    await comment("top", { age: 99_999 });
    const statements = [];
    for (let index = 0; index < PAGE_COMMENTS_MAX + 5; index += 1) {
      statements.push(
        db.prepare(`INSERT INTO comments (id, post_id, parent_id, author_id, body, depth, created_at) VALUES (?1, 'p1', 'top', 'u1', 'Reply', 1, ?2)`).bind(`x${index}`, NOW - 50_000 + index),
      );
    }
    await db.batch(statements);
    const page = (await postPage(db, "p1", "old"))!;
    expect(page.clipped).toBe(true);
    expect(page.comments).toHaveLength(1);
    expect(page.comments[0]!.replies).toHaveLength(PAGE_COMMENTS_MAX - 1);
  });

  it("opens a busy discussion best first", async () => {
    await post("p1");
    for (let index = 0; index < 30; index += 1) await comment(`c${index}`, { score: index % 7, age: 1000 - index });
    const page = await postPage(db, "p1");
    expect(page?.order).toBe("best");
    expect(page?.comments[0]?.score).toBe(6);
  });

  it("keeps removed and deleted comments in place, without text or author", async () => {
    await post("p1");
    await comment("root", { body: "SENTINEL_REMOVED_TEXT", removed: true, author: "u2" });
    await comment("reply", { parent: "root", body: "A surviving reply." });
    await comment("gone", { body: "SENTINEL_DELETED_TEXT", deleted: true });

    const page = await postPage(db, "p1");
    const root = page?.comments.find((c) => c.id === "root");
    const gone = page?.comments.find((c) => c.id === "gone");

    expect(root).toMatchObject({ state: "removed", body: null, author: null });
    expect(root?.replies.map((c) => c.id)).toEqual(["reply"]);
    expect(root?.replies[0].body).toBe("A surviving reply.");
    expect(gone).toMatchObject({ state: "deleted", body: null, author: null });
    expect(JSON.stringify(page)).not.toContain("SENTINEL");
  });

  it("never carries private profile fields", async () => {
    await user("u3", "tidal_wren_63", { banReason: "SENTINEL_BAN_REASON", role: "admin" });
    await post("p1", { author: "u3" });
    await comment("c1", { author: "u3" });

    const json = JSON.stringify(await postPage(db, "p1"));
    expect(json).not.toContain("SENTINEL_BAN_REASON");
    expect(json).not.toContain("admin");
    expect(json).not.toContain("banned");
  });

  it("shows a deleted account's content under a placeholder name", async () => {
    await user("u4", "left_the_board", { deletedAt: NOW - DAY });
    await post("p1", { author: "u4" });

    const page = await postPage(db, "p1");
    expect(page?.state === "live" && page.post.author.username).toBe("[deleted]");
    expect(JSON.stringify(page)).not.toContain("left_the_board");
  });
});

describe("profileByName", () => {
  it("finds a profile whatever the capitalization", async () => {
    await post("p1");
    const found = await profileByName(db, "Quiet_Otter_482");
    expect(found).toMatchObject({
      kind: "profile",
      profile: { username: "quiet_otter_482", karma: 12 },
    });
  });

  it("points an old name at the current one", async () => {
    await db
      .prepare(`INSERT INTO usernames (name, user_id, is_current, created_at) VALUES ('old_otter', 'u1', 0, ?1)`)
      .bind(NOW - 200 * DAY)
      .run();
    expect(await profileByName(db, "old_otter")).toEqual({
      kind: "renamed",
      username: "quiet_otter_482",
    });
  });

  it("lists only live posts and comments", async () => {
    await post("live");
    await post("removed", { removed: true, title: "SENTINEL_REMOVED_POST" });
    await post("deleted", { deleted: true, title: "SENTINEL_DELETED_POST" });
    await comment("ok", { post: "live", body: "A visible comment." });
    await comment("removed_c", { post: "live", body: "SENTINEL_REMOVED_COMMENT", removed: true });
    await comment("deleted_c", { post: "live", body: "SENTINEL_DELETED_COMMENT", deleted: true });
    // A visible comment on a removed post is not listed either.
    await comment("orphan", { post: "removed", body: "SENTINEL_ON_REMOVED_POST" });

    const found = await profileByName(db, "quiet_otter_482");
    expect(found?.kind).toBe("profile");
    if (found?.kind === "profile") {
      expect(found.profile.posts.map((p) => p.id)).toEqual(["live"]);
      expect(found.profile.comments.map((c) => c.id)).toEqual(["ok"]);
    }
    expect(JSON.stringify(found)).not.toContain("SENTINEL");
  });

  it("returns null for an unknown name or a deleted account", async () => {
    await user("u5", "gone_user", { deletedAt: NOW - DAY });
    expect(await profileByName(db, "nobody_here")).toBeNull();
    expect(await profileByName(db, "gone_user")).toBeNull();
  });
});

describe("duplicate links", () => {
  // Publishing decides when a link may go up again (see submit.test.ts); the
  // table itself lets a link stand on several posts, a month or more apart.
  it("lets a link stand on more than one post", async () => {
    await post("first", { key: "url:example.com/same", age: 40 * DAY });
    await expect(post("second", { key: "url:example.com/same" })).resolves.toBeUndefined();
  });
});
