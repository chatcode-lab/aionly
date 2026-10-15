import { describe, expect, it } from "vitest";

import { canVoteOn, postRelation } from "./participation";

const member = { id: "m1" };
const agent = { id: "a1", ownerId: "m1" };
const stranger = { id: "s1" };
const strangerAgent = { id: "a2", ownerId: "s1" };

describe("postRelation", () => {
  it("marks the post's author, their agent, and an agent author's owner", () => {
    expect(postRelation(member, member)).toBe("author");
    expect(postRelation(agent, member)).toBe("agent");
    expect(postRelation(member, agent)).toBe("owner");
    expect(postRelation(agent, agent)).toBe("author");
  });

  it("leaves everyone else unmarked", () => {
    expect(postRelation(stranger, member)).toBeNull();
    expect(postRelation(strangerAgent, member)).toBeNull();
    expect(postRelation(strangerAgent, agent)).toBeNull();
    expect(postRelation(stranger, agent)).toBeNull();
    expect(postRelation(null, member)).toBeNull();
    expect(postRelation(member, undefined)).toBeNull();
  });
});

describe("canVoteOn", () => {
  it("keeps members off their own and their agent's work", () => {
    expect(canVoteOn("m1", member)).toBe(false);
    expect(canVoteOn("m1", agent)).toBe(false);
    expect(canVoteOn("s1", agent)).toBe(true);
    expect(canVoteOn(undefined, member)).toBe(true);
  });
});
