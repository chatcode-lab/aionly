import { beforeEach, describe, expect, it } from "vitest";

import { searchPosts } from "../../app/lib/db/search.server";
import { matchExpression, SEARCH_LIMIT } from "../../app/lib/search";
import { db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("u1", "quiet_otter_482");
  await user("u2", "paper_lark_17");
});

const found = async (query: string) => (await searchPosts(db, query, NOW)).hits.map((hit) => hit.id);

/** What the index itself holds for a search, whatever the posts' state. */
const indexed = async (query: string) =>
  (await db.prepare(`SELECT rowid FROM posts_search WHERE posts_search MATCH ?1`).bind(matchExpression(query)).all()).results.length;

/** The index checked against the posts it reads from; throws when they differ. */
const intact = () => db.prepare(`INSERT INTO posts_search (posts_search, rank) VALUES ('integrity-check', 1)`).run();

describe("searching posts", () => {
  it("finds every word in the title or description, endings and accents folded, title matches first", async () => {
    await post("text", { title: "A walk through the city", description: "Generated with diffusion models, shot in a café." });
    await post("title", { title: "Diffusion model music video", description: "Made over a weekend." });
    await post("other", { title: "Something else", description: "Nothing to see." });

    expect(await found("diffusion")).toEqual(["title", "text"]);
    expect(await found("Models")).toEqual(["title", "text"]);
    expect(await found("cafe diffusion")).toEqual(["text"]);
    expect(await found("diffusion weekend")).toEqual(["title"]);
    expect(await found('"music video"')).toEqual(["title"]);
    expect(await found('"video music"')).toEqual([]);
    expect(await found("nowhere")).toEqual([]);
    expect(await found("")).toEqual([]);
  });

  it("never finds a removed or deleted post", async () => {
    await post("live", { title: "Robot choir" });
    await post("removed", { title: "Robot choir, removed", removed: true });
    await post("deleted", { title: "Robot choir, deleted", deleted: true });
    expect(await found("robot choir")).toEqual(["live"]);
  });

  it("keeps the index in step with edits and wiped text, and votes leave it alone", async () => {
    await post("p1", { title: "First title", description: "An old description." });
    await post("p2", { title: "Second", description: "Untouched." });
    await db.prepare(`UPDATE posts SET title = 'Renamed', description = 'A fresh description.' WHERE id = 'p1'`).run();
    expect(await found("fresh renamed")).toEqual(["p1"]);
    expect(await indexed("first")).toBe(0);
    expect(await indexed("old")).toBe(0);

    await db.prepare(`UPDATE posts SET score = 7, comment_count = 2 WHERE id = 'p2'`).run();
    // Deleting wipes a post's text in the same write.
    await db.prepare(`UPDATE posts SET deleted_at = ?1, title = '', description = '' WHERE id = 'p1'`).bind(NOW).run();
    expect(await indexed("renamed")).toBe(0);
    await db.prepare(`DELETE FROM posts WHERE id = 'p2'`).run();
    expect(await indexed("untouched")).toBe(0);
    await intact();
  });

  it("marks the matches in the title and in a plain snippet of the description, mentions as names", async () => {
    await post("p1", {
      title: "Diffusion explained",
      description: `Intro.\n\nSee **the paper** by <@u2> on [diffusion](https://arxiv.org/abs/1) and more.`,
    });
    const [hit] = (await searchPosts(db, "diffusion", NOW)).hits;
    expect(hit).toMatchObject({
      id: "p1",
      path: "/p/p1/diffusion-explained",
      title: ["", "Diffusion", " explained"],
      host: "example.com",
      author: { username: "quiet_otter_482" },
      score: 0,
      commentCount: 0,
    });
    expect(hit!.snippet.join("")).toBe("Intro. See the paper by @paper_lark_17 on diffusion (https://arxiv.org/abs/1) and more.");
    expect(hit!.snippet.filter((_, index) => index % 2 === 1)).toEqual(["diffusion"]);
  });

  it("shows the best matches up to the limit, and says there are more", async () => {
    await db.batch(
      Array.from({ length: SEARCH_LIMIT + 1 }, (_, n) =>
        db
          .prepare(
            `INSERT INTO posts (id, author_id, url, canonical_key, origin, title, description, created_at)
             VALUES (?1, 'u1', ?2, ?2, 'found', ?3, 'About agents.', ?4)`,
          )
          .bind(`p${n}`, `https://example.com/${n}`, `Agents ${n}`, NOW - n),
      ),
    );
    const { hits, more } = await searchPosts(db, "agents", NOW);
    expect(hits).toHaveLength(SEARCH_LIMIT);
    expect(more).toBe(true);
    expect((await searchPosts(db, "agents 7", NOW)).more).toBe(false);
  });

  it("is read through the index, in its order, with no sorting of its own", async () => {
    const { results } = await db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT post.id FROM posts_search JOIN posts AS post ON post.rowid = posts_search.rowid
         WHERE posts_search MATCH ?1 AND posts_search.rank MATCH 'bm25(4.0, 1.0)'
           AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL
         ORDER BY posts_search.rank LIMIT 51`,
      )
      .bind('"agents"')
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail);
    expect(plan[0]).toMatch(/^SCAN posts_search VIRTUAL TABLE/);
    expect(plan[1]).toMatch(/SEARCH post USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(plan.join(" | ")).not.toMatch(/TEMP B-TREE/);
  });
});
