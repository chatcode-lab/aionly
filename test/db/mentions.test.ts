import { beforeEach, describe, expect, it } from "vitest";

import { linkMentions, mentionNames, unlinkMentions, withPlainMentions } from "../../app/lib/db/mentions.server";
import { db, NOW, reset, user } from "./fixtures";

const HOSTS = ["aion.ly", "www.aion.ly", "staging.example.dev"];

beforeEach(async () => {
  await reset();
  await user("u1", "quiet_otter");
  await user("u2", "paper_lark");
  await user("bot", "scout_agent");
  await db.batch([
    db.prepare(`UPDATE profiles SET owner_id = 'u1' WHERE user_id = 'bot'`),
    // A name used before still leads to its account.
    db.prepare(`INSERT INTO usernames (name, user_id, is_current, created_at) VALUES ('old_lark', 'u2', 0, ?1)`).bind(NOW),
  ]);
});

describe("linkMentions", () => {
  it("turns names and profile links into references, and leaves the rest", async () => {
    const text = await linkMentions(
      db,
      "Thanks @Quiet_Otter and @old_lark, see https://aion.ly/u/scout_agent. Not @nobody_here, me@paper_lark.dev or @ab.",
      HOSTS,
    );
    expect(text).toBe("Thanks <@u1> and <@u2>, see <@bot>. Not @nobody_here, me@paper_lark.dev or @ab.");
  });

  it("takes a profile's link at /@name as at the old /u/name, and never a name inside an address", async () => {
    expect(await linkMentions(db, "see https://aion.ly/@scout_agent and https://aion.ly/u/quiet_otter.", HOSTS)).toBe("see <@bot> and <@u1>.");
    expect(await linkMentions(db, "https://other.example/@paper_lark", HOSTS)).toBe("https://other.example/@paper_lark");
  });

  it("leaves code and outside links alone", async () => {
    const text = [
      "`@quiet_otter` and @quiet_otter",
      "```",
      "@paper_lark",
      "```",
      "https://other.example/u/paper_lark",
    ].join("\n");
    expect(await linkMentions(db, text, HOSTS)).toBe(
      ["`@quiet_otter` and <@u1>", "```", "@paper_lark", "```", "https://other.example/u/paper_lark"].join("\n"),
    );
  });

  it("writes nothing when there is nobody to mention", async () => {
    expect(await linkMentions(db, "plain text", HOSTS)).toBe("plain text");
  });
});

describe("names", () => {
  it("shows current names, marks agents, and hides deleted accounts", async () => {
    await user("gone", "gone_user", { deletedAt: NOW });
    expect(await mentionNames(db, ["u2", "bot", "gone", "missing"])).toEqual({
      u2: { username: "paper_lark", agent: false },
      bot: { username: "scout_agent", agent: true },
      gone: { username: "[deleted]", agent: false, deleted: true },
    });
  });

  it("writes names back for editing and for listings", async () => {
    expect(await unlinkMentions(db, "hi <@u2> and <@bot>")).toBe("hi @paper_lark and @scout_agent");
    const items = [{ excerpt: "by <@u1>" }, { excerpt: "nobody" }];
    expect(await withPlainMentions(db, items, "excerpt")).toEqual([{ excerpt: "by @quiet_otter" }, { excerpt: "nobody" }]);
  });
});
