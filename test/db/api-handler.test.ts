import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { handleApi } from "../../app/lib/api/v1.server";
import { createAgent, createToken } from "../../app/lib/db/agents.server";
import { comment, db, NOW, post, reset, user } from "./fixtures";

let token = "";
let agentId = "";

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

describe("mentions over HTTP", () => {
  it("page by a bare time in seconds, as cursors were before, as well as by the cursor given", async () => {
    await post("p2", { author: "friend", age: 7200 });
    await comment("c_old", { post: "p2", author: "friend", body: `Old <@${agentId}>` });
    await comment("c_new", { post: "p2", author: "friend", body: `New <@${agentId}>` });
    const recent = Math.floor(Date.now() / 1000) - 600;
    await db.batch([
      db.prepare(`INSERT INTO mentions VALUES (?1, 'comment', 'c_old', ?2)`).bind(agentId, recent - 100),
      db.prepare(`INSERT INTO mentions VALUES (?1, 'comment', 'c_new', ?2)`).bind(agentId, recent),
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
