import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";

// The write limiters, as the handler sees them: open or exhausted.
const limits = vi.hoisted(() => ({ allow: true, asked: [] as string[] }));
vi.mock("../../app/lib/security/rate-limit.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../app/lib/security/rate-limit.server")>();
  return {
    ...original,
    withinLimits: vi.fn(async (_request: Request, kind: string) => {
      limits.asked.push(kind);
      return limits.allow;
    }),
  };
});

import { applyRename } from "../../app/lib/accounts/rename.server";
import { USERNAME_PROBLEM } from "../../app/lib/accounts/usernames";
import { issueTicket } from "../../app/lib/api/tickets.server";
import { handleApi } from "../../app/lib/api/v1.server";
import { createAgent, createToken } from "../../app/lib/db/agents.server";
import type { UploadPurpose } from "../../app/lib/mcp/tools";
import { comment, db, NOW, post, reset, user } from "./fixtures";

let token = "";
let agentId = "";
let tokenId = "";

beforeEach(async () => {
  await reset();
  limits.allow = true;
  limits.asked = [];
  await user("owner", "paying_owner", { plan: true });
  await user("friend", "kind_friend");
  const made = await createAgent(db, { ownerId: "owner", ownerName: "paying_owner", now: NOW });
  if (!made.ok) throw new Error("no agent");
  agentId = made.agent.id;
  const issued = await createToken(db, { agentId, label: "test", canWrite: true, now: NOW });
  if (!issued.ok) throw new Error("no token");
  token = issued.token;
  tokenId = issued.id;
});

const call = (method: string, path: string, body?: unknown) =>
  handleApi(
    new Request(`https://aion.ly/api/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    path.split("?")[0],
  );

describe("a paused agent opening its closed discussion again", () => {
  beforeEach(async () => {
    await post("p1", { author: agentId });
    await db.prepare(`UPDATE posts SET comments_closed_at = ?1 WHERE id = 'p1'`).bind(NOW).run();
    // The owner's plan ended: the agent is paused.
    await db.prepare(`UPDATE profiles SET plan_until = 1 WHERE user_id = 'owner'`).run();
  });

  it("is allowed, within the same write limits as everything else", async () => {
    const opened = await call("PATCH", "posts/p1", { replies: "all" });
    expect(opened.status, await opened.clone().text()).toBe(200);
    expect(limits.asked).toContain("write");
    expect(await db.prepare(`SELECT comments_closed_at FROM posts WHERE id = 'p1'`).first()).toEqual({ comments_closed_at: null });
  });

  it("answers 429 once the limit is spent, and changes nothing", async () => {
    limits.allow = false;
    const refused = await call("PATCH", "posts/p1", { replies: "all" });
    expect(refused.status).toBe(429);
    expect(await db.prepare(`SELECT comments_closed_at FROM posts WHERE id = 'p1'`).first()).toEqual({ comments_closed_at: NOW });
  });
});

describe("an agent choosing its name", () => {
  it("may end it in _agent, _bot, or _ai, which a person may not", async () => {
    const renamed = await call("PATCH", "me", { username: "news_bot" });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect((await renamed.json<{ username: string }>()).username).toBe("news_bot");
    expect(await applyRename("friend", "friend_bot")).toBe(USERNAME_PROBLEM.agent_ending);
    expect(await applyRename("friend", "friendly_robot")).toBeNull();
  });
});

describe("a connection without posting permission", () => {
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
  const picture = (path: string, ticket?: string) =>
    handleApi(
      new Request(`https://aion.ly/api/v1/${path}${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ""}`, {
        method: "PUT",
        headers: {
          ...(ticket ? {} : { Authorization: `Bearer ${token}` }),
          "Content-Type": "image/png",
          "Content-Length": String(png.byteLength),
          "CF-Connecting-IP": "203.0.113.9",
        },
        body: png,
      }),
      path,
    );
  const ticketFor = (purpose: UploadPurpose) =>
    issueTicket(env.BETTER_AUTH_SECRET, { agentId, tokenId }, purpose, Math.floor(Date.now() / 1000));

  beforeEach(async () => {
    await db.prepare(`UPDATE agent_tokens SET can_write = 0 WHERE id = ?1`).bind(tokenId).run();
  });

  it("can rename, subject to the usual name rules", async () => {
    const reserved = await call("PATCH", "me", { username: "aionly" });
    expect(reserved.status).toBe(409);
    expect(await reserved.json()).toMatchObject({ error: "username", fields: { username: USERNAME_PROBLEM.reserved } });
    const renamed = await call("PATCH", "me", { username: "news_bot" });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect(await renamed.json()).toMatchObject({ username: "news_bot", access: "read_only" });
    expect(limits.asked).toContain("write");
  });

  it.each([false, true])("can upload and remove profile pictures (upload ticket: %s)", async (withTicket) => {
    for (const [path, userId, purpose] of [["me/avatar", agentId, "avatar"], ["owner/avatar", "owner", "owner_avatar"]] as const) {
      const uploaded = await picture(path, withTicket ? await ticketFor(purpose) : undefined);
      expect(uploaded.status, await uploaded.clone().text()).toBe(200);
      expect(await uploaded.json()).toMatchObject({ avatar: expect.any(String) });
      const stored = await db.prepare(`SELECT avatar_key FROM profiles WHERE user_id = ?1`).bind(userId).first<{ avatar_key: string }>();
      expect(stored?.avatar_key).toBeTruthy();
      expect(await (await env.IMAGES.get(stored!.avatar_key))!.arrayBuffer()).toEqual(png.buffer);
      const removed = await call("DELETE", path);
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ avatar: null });
      expect(await env.IMAGES.get(stored!.avatar_key)).toBeNull();
    }
  });

  it("cannot create, edit, delete, or pin posts and comments, or upload their media", async () => {
    await post("mine", { author: agentId });
    await comment("c_mine", { post: "mine", author: agentId, body: "An original comment." });
    for (const [method, path] of [
      ["POST", "posts"], ["PATCH", "posts/mine"], ["DELETE", "posts/mine"],
      ["POST", "posts/mine/comments"], ["PATCH", "comments/c_mine"], ["DELETE", "comments/c_mine"],
      ["PUT", "posts/mine/pin"], ["DELETE", "posts/mine/pin"],
      ["POST", "uploads"], ["POST", "uploads?role=poster"],
    ] as const) {
      const refused = await call(method, path, { title: "Changed title", body: "Changed comment", comment_id: "c_mine" });
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await refused.json()).toMatchObject({ error: "read_only_token" });
    }
    expect(await db.prepare(`SELECT deleted_at, title FROM posts WHERE id = 'mine'`).first()).toEqual({ deleted_at: null, title: "Title of mine" });
    expect(await db.prepare(`SELECT deleted_at, body FROM comments WHERE id = 'c_mine'`).first()).toEqual({ deleted_at: null, body: "An original comment." });
  });

  it("checks posting permission again when a media or poster ticket is used", async () => {
    await db.prepare(`UPDATE agent_tokens SET can_write = 1 WHERE id = ?1`).bind(tokenId).run();
    const tickets = await Promise.all((["media", "poster"] as const).map(ticketFor));
    await db.prepare(`UPDATE agent_tokens SET can_write = 0 WHERE id = ?1`).bind(tokenId).run();
    for (const [index, path] of ["uploads", "uploads?role=poster"].entries()) {
      const refused = await handleApi(new Request(`https://aion.ly/api/v1/${path}${index ? "&" : "?"}ticket=${encodeURIComponent(tickets[index]!)}`, { method: "POST" }), "uploads");
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: "read_only_token" });
    }
  });

  it("keeps profile tickets bound to their purpose and a live token", async () => {
    const ticket = await ticketFor("avatar");
    expect((await picture("owner/avatar", ticket)).status).toBe(401);
    await db.prepare(`UPDATE agent_tokens SET revoked_at = ?1 WHERE id = ?2`).bind(NOW, tokenId).run();
    expect((await picture("me/avatar", ticket)).status).toBe(401);
    expect((await call("PATCH", "me", { username: "news_bot" })).status).toBe(401);
  });

  it.each(["paused", "banned", "read_only", "rate_limited"])("still refuses profile changes when %s", async (reason) => {
    if (reason === "paused") await db.prepare(`UPDATE profiles SET plan_until = 1 WHERE user_id = 'owner'`).run();
    if (reason === "banned") await db.prepare(`UPDATE profiles SET ban_reason = 'Test ban', banned_at = ?1 WHERE user_id = 'owner'`).bind(NOW).run();
    if (reason === "read_only") await db.prepare(`UPDATE profiles SET karma = -100 WHERE user_id IN ('owner', ?1)`).bind(agentId).run();
    if (reason === "rate_limited") limits.allow = false;
    for (const response of [await call("PATCH", "me", { username: "news_bot" }), await picture("me/avatar")]) {
      expect(response.status).toBe(reason === "rate_limited" ? 429 : 403);
      expect(await response.json()).toMatchObject({ error: reason });
    }
  });
});

describe("mentions over HTTP", () => {
  it("page by a bare time in seconds, as cursors were before, as well as by the cursor given", async () => {
    await post("p2", { author: "friend", age: 7200 });
    await comment("c_old", { post: "p2", author: "friend", body: `Old <@${agentId}>` });
    await comment("c_new", { post: "p2", author: "friend", body: `New <@${agentId}>` });
    const recent = Math.floor(Date.now() / 1000) - 600;
    await db.batch([
      db.prepare(`INSERT INTO mentions (target_id, item_type, item_id, created_at) VALUES (?1, 'comment', 'c_old', ?2)`).bind(agentId, recent - 100),
      db.prepare(`INSERT INTO mentions (target_id, item_type, item_id, created_at) VALUES (?1, 'comment', 'c_new', ?2)`).bind(agentId, recent),
    ]);
    const ids = async (query: string) => {
      const answer = (await (await call("GET", `me/mentions${query}`)).json()) as { mentions?: Array<{ id: string }> };
      if (!answer.mentions) throw new Error(JSON.stringify(answer));
      return answer.mentions.map((item) => item.id);
    };
    expect(await ids("")).toEqual(["c_new", "c_old"]);
    expect(await ids(`?before=${recent}`)).toEqual(["c_old"]);
    expect(await ids(`?before=${encodeURIComponent(`${recent}:comment:c_new:${agentId}`)}`)).toEqual(["c_old"]);
  });
});

describe("invitations for an agent's owner", () => {
  it("are listed and made by the agent, even with a token that only reads, against the owner's allowance", async () => {
    const readOnly = await createToken(db, { agentId, label: "reader", canWrite: false, now: NOW });
    if (!readOnly.ok) throw new Error("no token");
    token = readOnly.token;
    const before = (await (await call("GET", "me/invites")).json()) as { may_invite: boolean; allowance: number; left: number; invites: unknown[] };
    // The owner has the plan: five to start and five more.
    expect(before).toMatchObject({ may_invite: true, allowance: 10, left: 10, invites: [] });
    const made = await call("POST", "me/invites");
    expect(made.status).toBe(201);
    const invite = (await made.json()) as { code: string; url: string };
    expect(invite.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(invite.url).toBe(`https://aion.ly/invite/${invite.code}`);
    expect(await db.prepare(`SELECT inviter_id FROM invites WHERE code = ?1`).bind(invite.code).first()).toEqual({ inviter_id: "owner" });
    const after = (await (await call("GET", "me/invites")).json()) as { left: number; invites: Array<{ code: string }> };
    expect(after.left).toBe(9);
    expect(after.invites.map((item) => item.code)).toEqual([invite.code]);
  });

  it("are not made by a paused agent, nor past the limit", async () => {
    await db.prepare(`UPDATE profiles SET plan_until = 1 WHERE user_id = 'owner'`).run();
    const paused = await call("POST", "me/invites");
    expect(paused.status).toBe(403);
    expect(((await paused.json()) as { error: string }).error).toBe("paused");
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'owner'`).bind(NOW + 30 * 24 * 3600).run();
    for (let index = 0; index < 10; index += 1) expect((await call("POST", "me/invites")).status).toBe(201);
    const full = await call("POST", "me/invites");
    expect(full.status).toBe(403);
    expect(((await full.json()) as { error: string }).error).toBe("limit");
  });
});

describe("a long discussion over HTTP", () => {
  it("comes a page at a time, with the page holding a comment by ?c=", async () => {
    await post("long", { author: "friend" });
    const statements = [];
    for (let index = 0; index < 60; index += 1) {
      statements.push(
        db.prepare(`INSERT INTO comments (id, post_id, author_id, body, created_at) VALUES (?1, 'long', 'friend', 'A top-level comment.', ?2)`).bind(`t${String(index).padStart(2, "0")}`, NOW - 1000 + index),
      );
    }
    await db.batch(statements);
    const read = async (query: string) => (await (await call("GET", `posts/long${query}`)).json()) as { page: number; pages: number; comments_total: number; comments: Array<{ id: string }> };
    const first = await read("?order=old");
    expect(first).toMatchObject({ page: 1, pages: 2, comments_total: 60 });
    expect(first.comments).toHaveLength(50);
    expect((await read("?order=old&page=2")).comments.map((item) => item.id)).toEqual(Array.from({ length: 10 }, (_, index) => `t${50 + index}`));
    expect((await read("?order=old&c=t55")).page).toBe(2);
  });
});

describe("pinning through the API", () => {
  it("pins on the agent's own posts and its owner's, shows it, and takes it down", async () => {
    await post("mine", { author: agentId });
    await post("owners", { author: "owner" });
    await post("theirs", { author: "friend" });
    for (const [id, on] of [["c_mine", "mine"], ["c_owners", "owners"], ["c_theirs", "theirs"]] as const) {
      await comment(id, { post: on, author: "friend", body: "A comment worth pinning." });
    }
    const pinned = await call("PUT", "posts/mine/pin", { comment_id: "c_mine" });
    expect(pinned.status, await pinned.clone().text()).toBe(200);
    const read = (await (await call("GET", "posts/mine")).json()) as { comments: Array<{ id: string; pinned?: string }> };
    expect(read.comments[0]).toMatchObject({ id: "c_mine", pinned: "author" });
    expect((await call("PUT", "posts/owners/pin", { comment_id: "c_owners" })).status).toBe(200);
    expect((await call("PUT", "posts/theirs/pin", { comment_id: "c_theirs" })).status).toBe(403);
    expect((await call("DELETE", "posts/mine/pin")).status).toBe(200);
    expect(((await (await call("GET", "posts/mine")).json()) as { comments: Array<{ pinned?: string }> }).comments[0]!.pinned).toBeUndefined();
  });
});
