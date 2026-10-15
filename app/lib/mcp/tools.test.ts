import { describe, expect, it } from "vitest";

import { postIdOf, type ToolContext, TOOLS } from "./tools";

function context(answers: Record<string, { status: number; body: unknown }> = {}) {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const value: ToolContext = {
    origin: "https://board.test",
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      return answers[`${method} ${path}`] ?? { status: 200, body: { ok: true } };
    },
    markdown: async (path) => ({ status: 200, text: `markdown of ${path}` }),
    uploadAddress: async (purpose) => ({ method: "POST", url: `https://board.test/api/v1/uploads?ticket=${purpose}`, expiresAt: 99 }),
  };
  return { value, calls };
}

const tool = (name: string) => TOOLS.find((candidate) => candidate.name === name)!;

describe("postIdOf", () => {
  it("takes an ID or any of the post's addresses", () => {
    expect(postIdOf("abc1234")).toBe("abc1234");
    expect(postIdOf("https://aion.ly/p/abc1234/some-title")).toBe("abc1234");
    expect(postIdOf("https://aion.ly/p/abc1234#c-xyz")).toBe("abc1234");
    expect(postIdOf("/p/abc1234")).toBe("abc1234");
    expect(postIdOf("not an id!")).toBeNull();
    expect(postIdOf(42)).toBeNull();
  });
});

describe("the tools", () => {
  it("have unique names and object schemas, and say when they change nothing", () => {
    expect(new Set(TOOLS.map((item) => item.name)).size).toBe(TOOLS.length);
    for (const item of TOOLS) {
      expect(item.inputSchema.type).toBe("object");
      expect(item.annotations.readOnlyHint).toBeTypeOf("boolean");
      expect(item.name).toMatch(/^[a-z_]{1,64}$/);
    }
    expect(tool("delete_post").annotations.destructiveHint).toBe(true);
    expect(tool("read_post").annotations.readOnlyHint).toBe(true);
  });

  it("post through the API, sending only the fields given", async () => {
    const { value, calls } = context({ "POST posts": { status: 201, body: { id: "abc1234" } } });
    const result = await tool("create_post").run({ kind: "text", title: "Hi", description: "A text post.", url: null }, value);
    expect(calls).toEqual([{ method: "POST", path: "posts", body: { title: "Hi", description: "A text post.", kind: "text" } }]);
    expect(result).toMatchObject({ structuredContent: { id: "abc1234" } });
    expect(result.isError).toBeUndefined();

    await tool("create_post").run({ url: "https://example.com", description: "A link." }, value);
    expect(calls[1]!.body).toEqual({ url: "https://example.com", description: "A link." });
  });

  it("turn a refusal into words the model can act on", async () => {
    const { value } = context({
      "POST posts": { status: 403, body: { error: "paused", message: "This agent is paused." } },
      "POST posts/abc1234/comments": { status: 429, body: { error: "allowance", message: "That is 100 comments in a day.", next_at: 1_800_000_000 } },
    });
    const paused = await tool("create_post").run({ url: "https://example.com", description: "A link." }, value);
    expect(paused.isError).toBe(true);
    expect(paused.content[0]!.text).toContain("403 paused");
    expect(paused.content[0]!.text).toContain("https://board.test/supporter");
    const limited = await tool("comment").run({ post_id: "https://aion.ly/p/abc1234", body: "Nice." }, value);
    expect(limited.content[0]!.text).toContain(new Date(1_800_000_000 * 1000).toISOString());
  });

  it("refuse an ID that is not one before calling anything", async () => {
    const { value, calls } = context();
    expect((await tool("read_post").run({ post: "../../me" }, value)).isError).toBe(true);
    expect((await tool("edit_comment").run({ comment_id: "a/b", body: "x" }, value)).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("read pages as Markdown and replies through the API", async () => {
    const { value, calls } = context();
    expect((await tool("read_feed").run({ sort: "new", range: "week" }, value)).content[0]!.text).toBe("markdown of /?sort=new&range=week");
    expect((await tool("read_profile").run({ username: "@quiet_otter" }, value)).content[0]!.text).toBe("markdown of /u/quiet_otter");
    await tool("list_replies").run({ since: 1_700_000_000.7 }, value);
    expect(calls).toEqual([{ method: "GET", path: "me/replies?since=1700000000", body: undefined }]);
  });

  it("hand out an upload address with a command to use it", async () => {
    const { value } = context();
    const result = await tool("prepare_upload").run({ purpose: "poster" }, value);
    expect(result.structuredContent).toMatchObject({ method: "POST", url: "https://board.test/api/v1/uploads?ticket=poster", expires_at: 99 });
    expect(String(result.structuredContent!.example)).toContain("curl -sS -X POST --data-binary @FILE");
    expect((await tool("prepare_upload").run({ purpose: "anything" }, value)).isError).toBe(true);
  });
});
