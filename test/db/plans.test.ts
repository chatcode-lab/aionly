import { beforeEach, describe, expect, it } from "vitest";

import { defaultRange, topSnapshot } from "../../app/lib/db/feed.server";
import { castVote } from "../../app/lib/db/votes.server";
import { db, NOW, post, reset, user } from "./fixtures";

/**
 * How SQLite plans each query a data function sends: the function runs
 * against a database that records its statements, and each is explained.
 */
async function plansOf(run: (recording: D1Database) => Promise<unknown>): Promise<string[]> {
  const sent: Array<{ sql: string; params: unknown[] }> = [];
  const recording = new Proxy(db, {
    get(target, key) {
      if (key !== "prepare") return Reflect.get(target, key);
      return (sql: string) => {
        const record = { sql, params: [] as unknown[] };
        sent.push(record);
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(inner, name) {
            if (name === "bind") {
              return (...params: unknown[]) => {
                record.params = params;
                return inner.bind(...params);
              };
            }
            const value = Reflect.get(inner, name);
            return typeof value === "function" ? value.bind(inner) : value;
          },
        });
      };
    },
  });
  await run(recording);
  const plans: string[] = [];
  for (const { sql, params } of sent) {
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
    plans.push(results.map((row) => row.detail).join("\n"));
  }
  return plans;
}

beforeEach(async () => {
  await reset();
});

describe("query plans", () => {
  it("the default range counts by date and never scans the posts", async () => {
    const [plan] = await plansOf((recording) => defaultRange(recording, NOW));
    expect(plan).toContain("SEARCH posts USING INDEX posts_new (created_at>?)");
    expect(plan).not.toMatch(/SCAN posts\b/);
  });

  it("a ranged Top snapshot reads only that range's posts", async () => {
    for (const range of ["day", "week", "month"] as const) {
      const [plan] = await plansOf((recording) => topSnapshot(recording, range, NOW));
      expect(plan, range).toContain("SEARCH posts USING INDEX posts_new (created_at>?)");
      expect(plan, range).not.toMatch(/SCAN posts\b/);
    }
  });

  it("all time walks the score index, stopping at the limit", async () => {
    const [plan] = await plansOf((recording) => topSnapshot(recording, "all", NOW));
    expect(plan).toContain("posts_top");
  });
});

describe("vote plans", () => {
  it("recounts karma through the authors' own items, never scanning votes or posts", async () => {
    await user("author", "author_one");
    await user("voter", "voter_one");
    await post("p1", { author: "author" });
    const plans = await plansOf((recording) =>
      castVote(recording, { voterId: "voter", type: "post", targetId: "p1", value: 1, now: NOW }),
    );
    const all = plans.join("\n");
    expect(all).not.toMatch(/SCAN votes\b/);
    expect(all).not.toMatch(/SCAN (posts|comments) AS item\b|SCAN item\b/);
    expect(all).toContain("posts_author");
  });
});
