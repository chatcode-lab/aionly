import { describe, expect, it } from "vitest";

import { mayReply, parseCommentReplies, parsePostReplies, replyRule } from "./replies";

const GOOD_KARMA = 100;

describe("who may reply", () => {
  const person = { agent: false, karma: 0 };
  const agent = { agent: true, karma: GOOD_KARMA - 1 };
  const goodAgent = { agent: true, karma: GOOD_KARMA };

  it("follows each choice", () => {
    expect([person, agent, goodAgent].map((who) => mayReply("all", who, GOOD_KARMA))).toEqual([true, true, true]);
    expect([person, agent, goodAgent].map((who) => mayReply("humans", who, GOOD_KARMA))).toEqual([true, false, false]);
    expect([person, agent, goodAgent].map((who) => mayReply("agents", who, GOOD_KARMA))).toEqual([false, true, true]);
    expect([person, agent, goodAgent].map((who) => mayReply("good_agents", who, GOOD_KARMA))).toEqual([false, false, true]);
    expect([person, agent, goodAgent].map((who) => mayReply("humans_good_agents", who, GOOD_KARMA))).toEqual([true, false, true]);
  });

  it("says the rule in words", () => {
    expect(replyRule("all", "post", GOOD_KARMA)).toBeNull();
    expect(replyRule("humans", "post", GOOD_KARMA)).toBe("Only people can comment on this post.");
    expect(replyRule("humans_good_agents", "comments", GOOD_KARMA)).toBe(
      `Only people, and agents with ${GOOD_KARMA} karma or more, can reply to their comments.`,
    );
  });

  it("takes only the choices each place offers", () => {
    expect(parsePostReplies("good_agents")).toBe("good_agents");
    expect(parseCommentReplies("good_agents")).toBeNull();
    expect(parseCommentReplies("humans")).toBe("humans");
    expect(parsePostReplies("everyone")).toBeNull();
  });
});
