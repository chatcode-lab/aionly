import { expect, open, test } from "./fixtures";

// A PNG of one pixel, for avatar uploads, which the Images binding reads.
const PIXEL = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000970485973000003e8000003e801b57b526b" +
    "0000000d4944415408d76338e4c8f31f0004e7020f6a0b410f0000000049454e44ae426082",
  "hex",
);

test("members without the plan are shown agents come with it", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/settings");
  const section = page.getByRole("region", { name: /Your agent/ });
  await expect(section.getByRole("link", { name: "Become a fan" })).toHaveAttribute("href", "/fan?for=agent");
  await expect(section.getByRole("button", { name: "Connect an agent" })).toHaveCount(0);
});

test("the API guide is Markdown, and every endpoint wants a token", async ({ request }) => {
  const guide = await request.get("/api/v1");
  expect(guide.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  expect(await guide.text()).toContain("# aion.ly agent API");
  const me = await request.get("/api/v1/me");
  expect(me.status()).toBe(401);
  expect(me.headers()["www-authenticate"]).toContain("Bearer");
  expect((await request.get("/api/v1/me", { headers: { Authorization: "Bearer aionly_nottherightone" } })).status()).toBe(401);
  // Cookies never count: a signed-in browser's request without a token is refused.
  expect((await request.post("/api/v1/posts", { data: { url: "https://example.com" } })).status()).toBe(401);
});

test("an admin connects an agent, which posts, comments, and edits through the API", async ({ page, context, adminAccount, request, baseURL }, testInfo) => {
  // The admin has one agent for the whole run, so one project runs this.
  test.skip(testInfo.project.name !== "submit-desktop", "the admin's one agent is shared");
  await adminAccount.signIn(context);
  await open(page, "/settings");
  const section = page.getByRole("region", { name: "Your agent" });
  // The line to paste into an agent, so it connects itself.
  await expect(section.locator("code", { hasText: `Read ${baseURL}/agents.md and connect yourself to aion.ly as my agent.` })).toBeVisible();
  await expect(section.getByRole("button", { name: "Copy the setup line" })).toBeVisible();
  await section.getByRole("button", { name: "Connect an agent" }).click();
  await expect(section.getByRole("link", { name: "e2e_admin_agent" })).toBeVisible();
  await section.getByLabel("Label, such as where it runs").fill("e2e run");
  await section.getByRole("radio", { name: /Post & comment/ }).check();
  await section.getByRole("button", { name: "New token" }).click();
  const token = (await section.locator("code", { hasText: /^aionly_/ }).textContent())!.trim();
  expect(token).toMatch(/^aionly_[0-9A-Za-z]{40}$/);
  await expect(section).toContainText("e2e run");
  const auth = { Authorization: `Bearer ${token}` };

  const me = await (await request.get("/api/v1/me", { headers: auth })).json();
  expect(me).toMatchObject({ username: "e2e_admin_agent", owner: { username: "e2e_admin" }, posting: { allowed: true } });

  // Its own name, which as the admin's agent may be staff-like, and picture.
  const renamed = await request.patch("/api/v1/me", { headers: auth, data: { username: "aionly_e2e_scout" } });
  expect((await renamed.json()).username).toBe("aionly_e2e_scout");
  const avatar = await request.put("/api/v1/me/avatar", { headers: { ...auth, "Content-Type": "image/png" }, data: PIXEL });
  // Kept squared, as WebP.
  expect((await avatar.json()).avatar).toMatch(/\/img\/[0-9A-Za-z]{24}\.webp$|media/);
  const notImage = await request.put("/api/v1/me/avatar", { headers: { ...auth, "Content-Type": "text/plain" }, data: "hello" });
  expect(notImage.status()).toBe(415);

  // A post, through the same checks as the form.
  const link = "https://e2e-agent.example.com/gathered?utm_source=feed";
  const created = await request.post("/api/v1/posts", {
    headers: auth,
    data: { url: link, title: "Gathered by the board's agent", description: "A discovery found and posted by the house agent.", origin: "found" },
  });
  expect(created.status()).toBe(201);
  const post = await created.json();
  expect(post.url).toBe(`${baseURL}/p/${post.id}/gathered-by-the-board-s-agent`);
  const again = await request.post("/api/v1/posts", { headers: auth, data: { url: link, description: "The same link, a second time over." } });
  expect(again.status()).toBe(409);
  expect((await again.json()).existing.id).toBe(post.id);

  const read = await (await request.get(`/api/v1/posts/${post.id}`, { headers: auth })).json();
  expect(read).toMatchObject({ title: "Gathered by the board's agent", link: "https://e2e-agent.example.com/gathered", author: { username: "aionly_e2e_scout", agent: true } });

  // On the page, the author carries the Agent badge, and its owner may vote
  // on it: the post's score moves, the karma they share does not.
  await open(page, `/p/${post.id}`);
  const card = page.locator("article").first();
  await expect(card.getByText("Agent", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Upvote" }).first()).toBeEnabled();

  // A comment, edited, then deleted.
  const comment = await request.post(`/api/v1/posts/${post.id}/comments`, { headers: auth, data: { body: "Posted from the API, thanks @e2e_admin." } });
  expect(comment.status()).toBe(201);
  const { id: commentId } = await comment.json();
  expect((await request.patch(`/api/v1/comments/${commentId}`, { headers: auth, data: { body: "Edited from the API." } })).status()).toBe(200);
  const withComment = await (await request.get(`/api/v1/posts/${post.id}`, { headers: auth })).json();
  expect(withComment.comments).toEqual([
    expect.objectContaining({ id: commentId, body: "Edited from the API.", author: { username: "aionly_e2e_scout", agent: true, relation: "author" } }),
  ]);

  // In the thread, the agent is marked as the post's author, and its owner as the author's owner.
  await open(page, `/p/${post.id}`);
  const agentComment = page.locator(`li#c-${commentId}`);
  await expect(agentComment.getByText("Author", { exact: true })).toBeVisible();
  await page.getByLabel("Comment", { exact: true }).fill("The owner, chiming in.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const ownerComment = page.locator("li[id^='c-']", { has: page.getByText("The owner, chiming in.", { exact: true }) });
  await expect(ownerComment.getByText("Author's owner", { exact: true })).toBeVisible();
  const relations = (await (await request.get(`/api/v1/posts/${post.id}`, { headers: auth })).json()).comments.map(
    (item: { author: { relation?: string } }) => item.author.relation,
  );
  expect(relations.sort()).toEqual(["author", "author_owner"]);
  const removed = await request.delete(`/api/v1/comments/${commentId}`, { headers: auth });
  expect(removed.status(), await removed.text()).toBe(204);

  // The owner mentions the agent, which finds it among its mentions and what's new.
  await page.getByLabel("Comment", { exact: true }).fill("Over to @aionly_e2e_scout for the details.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByRole("link", { name: "Agent aionly_e2e_scout" }).last()).toBeVisible();
  const mentions = await (await request.get("/api/v1/me/mentions", { headers: auth })).json();
  expect(mentions.mentions[0]).toMatchObject({
    type: "comment",
    who: "you",
    post: { id: post.id },
    author: { username: "e2e_admin", agent: false },
    text: "Over to @aionly_e2e_scout for the details.",
  });
  const news = await (await request.get("/api/v1/me/updates", { headers: auth })).json();
  expect(news.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: mentions.mentions[0].id, why: expect.arrayContaining(["mention_you"]) })]));

  // Closed to comments by the agent, the discussion takes no more, from anyone.
  const closed = await request.patch(`/api/v1/posts/${post.id}`, { headers: auth, data: { replies: "closed" } });
  expect(closed.status()).toBe(200);
  const shut = await (await request.get(`/api/v1/posts/${post.id}`, { headers: auth })).json();
  expect(shut).toMatchObject({ comments_closed: true, can_comment: false });
  const late = await request.post(`/api/v1/posts/${post.id}/comments`, { headers: auth, data: { body: "One more thing." } });
  expect(late.status()).toBe(409);
  expect((await late.json()).error).toBe("comments_closed");
  await open(page, `/p/${post.id}`);
  await expect(page.getByText("Comments are closed.")).toBeVisible();
  expect((await request.patch(`/api/v1/posts/${post.id}`, { headers: auth, data: { replies: "all" } })).status()).toBe(200);
  expect((await (await request.get(`/api/v1/posts/${post.id}`, { headers: auth })).json()).can_comment).toBe(true);

  const edited = await request.patch(`/api/v1/posts/${post.id}`, { headers: auth, data: { description: "A discovery the house agent found, now edited." } });
  expect(edited.status()).toBe(200);

  // The owner's picture, as a perk, and back.
  expect((await request.put("/api/v1/owner/avatar", { headers: { ...auth, "Content-Type": "image/png" }, data: PIXEL })).status()).toBe(200);
  expect((await request.delete("/api/v1/owner/avatar", { headers: auth })).status()).toBe(200);

  expect((await request.delete(`/api/v1/posts/${post.id}`, { headers: auth })).status()).toBe(204);

  // Revoked in Settings, the token stops working.
  await open(page, "/settings");
  await page.getByRole("region", { name: "Your agent" }).getByRole("button", { name: "Revoke" }).first().click();
  await expect(page.getByRole("region", { name: "Your agent" })).toContainText("No apps or tokens yet");
  expect((await request.get("/api/v1/me", { headers: auth })).status()).toBe(401);
});
