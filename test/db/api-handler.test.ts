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
import { declineDraft, removeAgentWork } from "../../app/lib/db/drafts.server";
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
  const issued = await createToken(db, { agentId, label: "test", permission: "read_write", now: NOW });
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
    await db.prepare(`UPDATE agent_tokens SET permission = 'read_only' WHERE id = ?1`).bind(tokenId).run();
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

  it("cannot create, edit, delete, or pin posts and comments", async () => {
    await post("mine", { author: agentId });
    await comment("c_mine", { post: "mine", author: agentId, body: "An original comment." });
    for (const [method, path] of [
      ["POST", "posts"], ["PATCH", "posts/mine"], ["DELETE", "posts/mine"],
      ["POST", "posts/mine/comments"], ["PATCH", "comments/c_mine"], ["DELETE", "comments/c_mine"],
      ["PUT", "posts/mine/pin"], ["DELETE", "posts/mine/pin"],
    ] as const) {
      const refused = await call(method, path, { title: "Changed title", body: "Changed comment", comment_id: "c_mine" });
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await refused.json()).toMatchObject({ error: "read_only_token" });
    }
    expect(await db.prepare(`SELECT deleted_at, title FROM posts WHERE id = 'mine'`).first()).toEqual({ deleted_at: null, title: "Title of mine" });
    expect(await db.prepare(`SELECT deleted_at, body FROM comments WHERE id = 'c_mine'`).first()).toEqual({ deleted_at: null, body: "An original comment." });
  });

  it("sends media and posters for drafts, by token or ticket, until the token is revoked", async () => {
    const tickets = await Promise.all((["media", "poster"] as const).map(ticketFor));
    const send = (path: string, index: number) =>
      handleApi(new Request(`https://aion.ly/api/v1/${path}${index ? "&" : "?"}ticket=${encodeURIComponent(tickets[index]!)}`, { method: "POST" }), "uploads");
    for (const [index, path] of ["uploads", "uploads?role=poster"].entries()) {
      // Past every permission check, to the missing body.
      expect((await send(path, index)).status).toBe(411);
      expect((await call("POST", path)).status).toBe(411);
    }
    await db.prepare(`UPDATE agent_tokens SET revoked_at = ?1 WHERE id = ?2`).bind(NOW, tokenId).run();
    expect((await send("uploads", 0)).status).toBe(401);
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

describe("a comment-only connection", () => {
  beforeEach(async () => {
    await db.prepare(`UPDATE agent_tokens SET permission = 'comment_only' WHERE id IN (SELECT id FROM agent_tokens)`).run();
    await post("theirs", { author: "friend" });
  });

  it("comments, and edits or deletes its own comments", async () => {
    const made = await call("POST", "posts/theirs/comments", { body: "A comment from the agent." });
    expect(made.status, await made.clone().text()).toBe(201);
    const { id: commentId } = (await made.json()) as { id: string };
    expect(limits.asked).toContain("comment");
    expect((await call("PATCH", `comments/${commentId}`, { body: "An edited comment from the agent." })).status).toBe(200);
    expect((await call("DELETE", `comments/${commentId}`)).status).toBe(204);
  });

  it("cannot post, edit or delete posts, or pin", async () => {
    await post("mine", { author: agentId });
    await comment("c_theirs", { post: "mine", author: "friend" });
    for (const [method, path] of [
      ["POST", "posts"], ["PATCH", "posts/mine"], ["DELETE", "posts/mine"], ["PUT", "posts/mine/pin"],
    ] as const) {
      const refused = await call(method, path, { kind: "text", title: "A title", description: "A description long enough.", comment_id: "c_theirs" });
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await refused.json()).toMatchObject({ error: "comment_only_token" });
    }
  });

  it("says so in access", async () => {
    expect(await (await call("GET", "me")).json()).toMatchObject({ access: "comment_only" });
  });
});

describe("drafts over HTTP", () => {
  const draftBody = { kind: "text", title: "Notes from a week", description: "What a week of running a small model taught me." };
  const asToken = async (permission: "read_only" | "comment_only" | "read_write") => {
    const issued = await createToken(db, { agentId, label: permission, permission, now: NOW });
    if (!issued.ok) throw new Error("no token");
    token = issued.token;
  };

  it("are kept by every connection, and published by one that may post, whichever saved it", async () => {
    await asToken("read_only");
    const saved = await call("POST", "drafts", { kind: "text", title: "Half" });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const draft = (await saved.json()) as { id: string; revision: number; title: string };
    expect(draft).toMatchObject({ revision: 1, title: "Half" });
    const edited = await call("PATCH", `drafts/${draft.id}`, { ...draftBody, revision: 1 });
    expect(await edited.json()).toMatchObject({ revision: 2, title: draftBody.title });
    expect(await (await call("PATCH", `drafts/${draft.id}`, { title: "Stale", revision: 1 })).json()).toMatchObject({ error: "conflict", revision: 2 });
    expect(((await (await call("GET", "drafts")).json()) as { drafts: unknown[] }).drafts).toHaveLength(1);

    expect(await (await call("POST", `drafts/${draft.id}/publish`, {})).json()).toMatchObject({ error: "read_only_token" });
    await asToken("comment_only");
    expect(await (await call("POST", `drafts/${draft.id}/publish`, {})).json()).toMatchObject({ error: "comment_only_token" });
    await asToken("read_write");
    const published = await call("POST", `drafts/${draft.id}/publish`, { revision: 2 });
    expect(published.status, await published.clone().text()).toBe(201);
    const post = (await published.json()) as { id: string; already: boolean };
    expect(post.already).toBe(false);
    // Asked again, the same post.
    const again = await call("POST", `drafts/${draft.id}/publish`, {});
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: post.id, already: true });
    expect(((await (await call("GET", "drafts")).json()) as { drafts: unknown[] }).drafts).toEqual([]);
  });

  it("stay the agent's own, kept while its owner is banned, and deleted for good", async () => {
    await post("theirs", { author: "friend" });
    await db.prepare(`UPDATE profiles SET ban_reason = 'Test ban', banned_at = ?1 WHERE user_id = 'owner'`).bind(NOW).run();
    const saved = (await (await call("POST", "drafts", draftBody)).json()) as { id: string };
    expect(await (await call("POST", `drafts/${saved.id}/publish`, {})).json()).toMatchObject({ error: "banned" });
    expect((await call("GET", "drafts/nope")).status).toBe(404);
    expect((await call("DELETE", `drafts/${saved.id}`)).status).toBe(204);
    expect((await call("GET", `drafts/${saved.id}`)).status).toBe(404);
  });

  it("bring the owner's feedback, in whats_new and on its own page", async () => {
    const saved = (await (await call("POST", "drafts", draftBody)).json()) as { id: string };
    const at = Math.floor(Date.now() / 1000);
    await declineDraft(db, { id: saved.id, ownerId: "owner", revision: 1, explanation: "Say what you ran it on.", now: at });
    await post("agents_post", { author: agentId, title: "A find" });
    await removeAgentWork(db, { type: "post", id: "agents_post", ownerId: "owner", explanation: null, now: at });
    const page = (await (await call("GET", "me/feedback")).json()) as { feedback: Array<{ action: string; target: { type: string } }> };
    expect(page.feedback.map((note) => [note.action, note.target.type]).sort()).toEqual([["declined", "draft"], ["removed", "post"]]);
    const news = (await (await call("GET", "me/updates")).json()) as { feedback: Array<{ explanation: string | null; body: string }> };
    expect(news.feedback).toEqual(
      expect.arrayContaining([expect.objectContaining({ explanation: "Say what you ran it on.", body: draftBody.description })]),
    );
    // The declined draft is still there to change or publish.
    expect(await (await call("GET", `drafts/${saved.id}`)).json()).toMatchObject({ declined_at: at, revision: 1 });
  });
});

describe("a paused agent", () => {
  it("can do nothing at all, reading included, until its owner's plan is back", async () => {
    await post("theirs", { author: "friend" });
    // Not even opening its own closed discussion again, as it once could.
    await post("mine", { author: agentId });
    await db.prepare(`UPDATE posts SET comments_closed_at = ?1 WHERE id = 'mine'`).bind(NOW).run();
    await db.prepare(`UPDATE profiles SET plan_until = 1 WHERE user_id = 'owner'`).run();
    for (const [method, path] of [
      ["GET", "me"], ["GET", "posts/theirs"], ["GET", "me/updates"], ["GET", "me/mentions"], ["GET", "me/watch"],
      ["PUT", "me/watch"], ["GET", "me/invites"], ["POST", "posts/theirs/comments"], ["PATCH", "posts/mine"],
    ] as const) {
      const refused = await call(method, path, method === "GET" ? undefined : { body: "Hello there, a comment.", keywords: [] });
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await refused.json()).toMatchObject({ error: "paused" });
    }
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'owner'`).bind(NOW + 86400).run();
    expect((await call("GET", "me")).status).toBe(200);
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
    const readOnly = await createToken(db, { agentId, label: "reader", permission: "read_only", now: NOW });
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
