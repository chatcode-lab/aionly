import { describe, expect, it } from "vitest";

import type { CommentData } from "./public-types";
import { authorData, commentsData } from "./structured-data";

const BASE = "https://aion.ly/p/abc/a-post";
const PATH = "/p/abc/a-post";

function comment(id: string, extra: Partial<CommentData> = {}): CommentData {
  return {
    id,
    author: { id: `u_${id}`, username: `member_${id}` },
    createdAt: Date.UTC(2026, 9, 22, 14, 0) / 1000,
    score: 2,
    body: `Comment ${id}`,
    state: "visible",
    replies: [],
    ...extra,
  };
}

describe("a post page's comments, as structured data", () => {
  it("give each comment its author, time, whole text without markup, likes, and address, replies nested in page order", () => {
    const thread = [
      comment("c1", {
        body: "See [the paper](https://arxiv.org/abs/1706.03762), <@u_9>.\n\nAnd ~~old~~ **this**.",
        replies: [comment("c2", { author: { id: "u_a", username: "aisha", agent: true }, score: -3 })],
      }),
      comment("c3"),
    ];
    const marked = commentsData(thread, PATH, BASE, { u_9: { username: "quiet_otter_482", agent: false } });
    expect(marked).toEqual([
      {
        "@type": "Comment",
        url: "https://aion.ly/p/abc/a-post?c=c1#c-c1",
        datePublished: "2026-10-22T14:00:00.000Z",
        author: { "@type": "Person", name: "member_c1", url: "https://aion.ly/@member_c1" },
        text: "See the paper (https://arxiv.org/abs/1706.03762), @quiet_otter_482.\nAnd old this.",
        interactionStatistic: { "@type": "InteractionCounter", interactionType: "https://schema.org/LikeAction", userInteractionCount: 2 },
        comment: [
          expect.objectContaining({
            url: "https://aion.ly/p/abc/a-post?c=c2#c-c2",
            author: { "@type": "Organization", name: "aisha", url: "https://aion.ly/@aisha" },
            text: "Comment c2",
            interactionStatistic: expect.objectContaining({ userInteractionCount: 0 }),
          }),
        ],
      },
      expect.objectContaining({ url: "https://aion.ly/p/abc/a-post?c=c3#c-c3", text: "Comment c3" }),
    ]);
    expect(marked[1]).not.toHaveProperty("comment");
  });

  it("keep a removed or deleted comment only to hold its replies, marked Deleted, as the page shows it", () => {
    const gone = { author: null, body: null };
    const marked = commentsData(
      [
        comment("c1", { ...gone, state: "deleted", replies: [comment("c2")] }),
        comment("c3", { ...gone, state: "removed", replies: [comment("c4", { ...gone, state: "deleted" })] }),
        comment("c5", { ...gone, state: "removed", replies: [comment("c6")] }),
      ],
      PATH,
      BASE,
      {},
    );
    expect(marked).toEqual([
      {
        "@type": "Comment",
        url: "https://aion.ly/p/abc/a-post?c=c1#c-c1",
        datePublished: "2026-10-22T14:00:00.000Z",
        creativeWorkStatus: "Deleted",
        author: { "@type": "Person", name: "[deleted]" },
        text: "[deleted by author]",
        comment: [expect.objectContaining({ text: "Comment c2" })],
      },
      expect.objectContaining({ creativeWorkStatus: "Deleted", text: "[removed by moderator]", comment: [expect.objectContaining({ text: "Comment c6" })] }),
    ]);
  });

  it("spell out at most so many comments, in page order, replies included", () => {
    const thread = [comment("c1", { replies: [comment("c2"), comment("c3")] }), comment("c4"), comment("c5")];
    const marked = commentsData(thread, PATH, BASE, {}, 3);
    expect(marked).toHaveLength(1);
    expect((marked[0]!.comment as unknown[]).length).toBe(2);
    expect(commentsData(thread, PATH, BASE, {}, 4).map((entry) => entry.text)).toEqual(["Comment c1", "Comment c4"]);
    // A tombstone left out for holding nothing takes no place.
    const tombstone = comment("c0", { author: null, body: null, state: "deleted" });
    expect(commentsData([tombstone, ...thread], PATH, BASE, {}, 4).map((entry) => entry.text)).toEqual(["Comment c1", "Comment c4"]);
  });

  it("name a deleted account without a profile", () => {
    expect(authorData({ username: "[deleted]" }, BASE)).toEqual({ "@type": "Person", name: "[deleted]" });
  });
});
