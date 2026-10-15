import { beforeEach, describe, expect, it } from "vitest";

import {
  describeWatch,
  EMPTY_WATCH,
  resolveWatchTargets,
  saveWatchList,
  updatesFor,
  type WatchList,
  watchListOf,
} from "../../app/lib/db/updates.server";
import { comment, db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("o1", "owner_otter");
  await user("a1", "scout_agent");
  await db.prepare(`UPDATE profiles SET owner_id = 'o1' WHERE user_id = 'a1'`).run();
  await user("u2", "paper_lark");
  await user("u3", "quiet_wren");
});

const SINCE = NOW - 3600;
const updates = (watch: WatchList = EMPTY_WATCH, since = SINCE) =>
  updatesFor(db, { agentId: "a1", ownerId: "o1", watch, since, now: NOW });
const why = (found: Awaited<ReturnType<typeof updates>>) =>
  Object.fromEntries(found.items.map((item) => [item.id, item.why]));

describe("what's new for an agent", () => {
  it("brings replies to the agent and its owner, and the owner's own posts and comments", async () => {
    await post("agent-post", { author: "a1", age: 7200 });
    await post("owner-old", { author: "o1", age: 7200 });
    await post("owner-new", { author: "o1", age: 600 });
    await post("other", { author: "u2", age: 7200 });
    await comment("to-agent", { post: "agent-post", author: "u2", age: 300 });
    await comment("owner-said", { post: "other", author: "o1", age: 500 });
    await comment("to-owner", { post: "other", parent: "owner-said", author: "u3", age: 200, depth: 1 });
    // Not news: before the window, the agent's own words, deleted, or by the owner on its own post.
    await comment("too-old", { post: "agent-post", author: "u2", age: 5000 });
    await comment("by-agent", { post: "other", author: "a1", age: 100 });
    await comment("deleted", { post: "agent-post", author: "u2", age: 100, deleted: true });

    const found = await updates();
    expect(why(found)).toEqual({
      "to-agent": ["reply_to_you"],
      "owner-said": ["owner"],
      "to-owner": ["reply_to_owner"],
      "owner-new": ["owner"],
    });
    expect(found.items.map((item) => item.id)).toEqual(["to-owner", "to-agent", "owner-said", "owner-new"]);
    expect(found).toMatchObject({ since: SINCE, until: NOW, complete: true });
    expect(found.items[0]).toMatchObject({ type: "comment", postId: "other", parentId: "owner-said", author: { username: "quiet_wren" } });
  });

  it("follows watched posts, people, and whole-word keywords", async () => {
    await post("watched", { author: "u2", age: 7200 });
    await post("by-u3", { author: "u3", age: 900, title: "Something else" });
    await post("suno-post", { author: "u2", age: 800, title: "A song made with Suno", description: "It is a song." });
    await post("not-a-word", { author: "u2", age: 700, title: "Unsunoed", description: "No keyword as a word here." });
    await comment("on-watched", { post: "watched", author: "u2", age: 400 });
    await comment("u3-said", { post: "watched", author: "u3", age: 300 });
    await comment("model-talk", { post: "by-u3", author: "u2", age: 200, body: "The new VIDEO   model is slow." });

    const found = await updates({ keywords: ["suno", "video model"], posts: ["watched"], users: ["u3"] });
    expect(why(found)).toEqual({
      "by-u3": ["watched_user"],
      "suno-post": ["keyword"],
      "on-watched": ["watched_post"],
      "u3-said": ["watched_post", "watched_user"],
      "model-talk": ["keyword"],
    });
    expect(found.items.find((item) => item.id === "model-talk")?.keywords).toEqual(["video model"]);
  });

  it("ends the window early when a source fills up, so the next call carries on", async () => {
    await post("watched", { author: "u2", age: 7200 });
    for (let index = 0; index < 55; index += 1) {
      await comment(`c${String(index).padStart(2, "0")}`, { post: "watched", author: "u2", age: 3000 - index * 10 });
    }
    const first = await updates({ ...EMPTY_WATCH, posts: ["watched"] });
    expect(first.complete).toBe(false);
    expect(first.items).toHaveLength(49);
    const second = await updates({ ...EMPTY_WATCH, posts: ["watched"] }, first.until);
    expect(second.complete).toBe(true);
    const ids = [...first.items, ...second.items].map((item) => item.id).sort();
    expect(ids).toEqual(Array.from({ length: 55 }, (_, index) => `c${String(index).padStart(2, "0")}`));
  });

  it("cuts long text and says so", async () => {
    await post("watched", { author: "u2", age: 7200 });
    await comment("long", { post: "watched", author: "u2", age: 100, body: "x".repeat(3000) });
    const [item] = (await updates({ ...EMPTY_WATCH, posts: ["watched"] })).items;
    expect(item).toMatchObject({ truncated: true });
    expect(item && item.text.length).toBe(1000);
  });
});

describe("the watch list", () => {
  it("is kept on the agent, and names people and posts as they are now", async () => {
    await post("p1", { author: "u2", title: "A post" });
    await post("gone", { author: "u2", deleted: true });
    await saveWatchList(db, "a1", { keywords: ["suno"], posts: ["p1", "gone"], users: ["u3"] });
    await db.prepare(`UPDATE usernames SET is_current = 0 WHERE user_id = 'u3'`).run();
    await db.prepare(`INSERT INTO usernames (name, user_id, is_current, created_at) VALUES ('new_wren', 'u3', 1, ?1)`).bind(NOW).run();

    const list = await watchListOf(db, "a1");
    expect(await describeWatch(db, list)).toEqual({
      keywords: ["suno"],
      posts: [
        { id: "p1", title: "A post", path: "/p/p1/a-post", live: true },
        { id: "gone", title: null, path: "/p/gone", live: false },
      ],
      users: [{ id: "u3", username: "new_wren", agent: false }],
    });
    // A member's own profile never holds a list.
    await saveWatchList(db, "o1", { keywords: ["x"], posts: [], users: [] });
    expect(await watchListOf(db, "o1")).toEqual(EMPTY_WATCH);
  });

  it("finds people by any name they used, and only posts that exist", async () => {
    await post("p1", { author: "u2" });
    await db.prepare(`INSERT INTO usernames (name, user_id, is_current, created_at) VALUES ('old_lark', 'u2', 0, ?1)`).bind(NOW).run();
    const found = await resolveWatchTargets(db, { names: ["old_lark", "quiet_wren", "nobody"], postIds: ["p1", "p404"] });
    expect(Object.fromEntries(found.users)).toEqual({ old_lark: "u2", quiet_wren: "u3" });
    expect([...found.posts]).toEqual(["p1"]);
  });
});
