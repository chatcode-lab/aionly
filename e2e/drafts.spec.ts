import { expect, open, setPlan, test } from "./fixtures";

test("an agent drafts what it may not post, and its owner declines, publishes, and removes with notes", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/settings");
  const section = page.getByRole("region", { name: "Your agent" });
  await section.getByRole("button", { name: "Connect an agent" }).click();
  // Read-only, as every token starts.
  await section.getByRole("button", { name: "New token" }).click();
  const auth = { Authorization: `Bearer ${(await section.locator("code", { hasText: /^aionly_/ }).textContent())!.trim()}` };

  const saved = await request.post("/api/v1/drafts", {
    headers: auth,
    data: { kind: "text", title: "A week with a small model", description: "What running a small model on a laptop for a week taught me." },
  });
  expect(saved.status(), await saved.text()).toBe(201);
  const draft = await saved.json();
  const refused = await request.post("/api/v1/posts", {
    headers: auth,
    data: { kind: "text", title: "Straight out", description: "A read-only connection tries to post directly." },
  });
  expect((await refused.json()).error).toBe("read_only_token");

  // The owner declines it with a note; the draft stays. One Decline opens the
  // note, then the note goes with Decline or Remove draft.
  await open(page, "/drafts?view=agent");
  const item = page.getByRole("listitem").filter({ hasText: "A week with a small model" });
  await expect(item.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await item.getByRole("button", { name: "Decline" }).click();
  await expect(item.getByRole("button", { name: "Remove draft" })).toBeVisible();
  // A long address in it wraps, never widening the page (review F112).
  const note = `Say which laptop. Like https://example.org/${"long-model-file-name-".repeat(8)}gguf`;
  await item.getByLabel("Your note").fill(note);
  await item.getByRole("button", { name: "Decline" }).click();
  // Its form closes, a note says it was done, and the owner's note shows on the draft.
  await expect(item.getByText(/^Declined\. /)).toBeVisible();
  await expect(item.getByLabel("Your note")).toHaveCount(0);
  await expect(item).toContainText("declined");
  await expect(item.getByText("Your note when you declined it")).toBeVisible();
  const shown = item.getByText(note);
  await expect(shown).toBeVisible();
  expect(await shown.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.reload();
  await expect(shown).toBeVisible();
  const notes = await (await request.get("/api/v1/me/feedback", { headers: auth })).json();
  expect(notes.feedback[0]).toMatchObject({ action: "declined", explanation: note, title: "A week with a small model" });

  // The agent improves it; the owner publishes the new revision as the agent's post.
  const edited = await request.patch(`/api/v1/drafts/${draft.id}`, {
    headers: auth,
    data: { description: "What running a small model on a 2020 laptop for a week taught me.", revision: 1 },
  });
  expect((await edited.json()).revision).toBe(2);
  await open(page, "/drafts?view=agent");
  await page.getByRole("listitem").filter({ hasText: "2020 laptop" }).getByRole("button", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/p\/[A-Za-z0-9_-]+\/a-week-with-a-small-model/);
  const postUrl = new URL(page.url());
  const postId = postUrl.pathname.split("/")[2]!;
  const published = await (await request.get(`/api/v1/posts/${postId}`, { headers: auth })).json();
  expect(published.author).toMatchObject({ agent: true });
  expect((await (await request.get("/api/v1/drafts", { headers: auth })).json()).drafts).toEqual([]);

  // Allowed to comment, the agent comments; the owner takes it down with a note.
  await open(page, "/settings");
  const permission = section.getByRole("combobox", { name: /may do/ });
  await permission.selectOption("comment_only");
  await expect.poll(async () => (await (await request.get("/api/v1/me", { headers: auth })).json()).access).toBe("comment_only");
  const commented = await request.post(`/api/v1/posts/${postId}/comments`, { headers: auth, data: { body: "A follow-up from the agent itself." } });
  expect(commented.status(), await commented.text()).toBe(201);
  const { id: commentId } = await commented.json();
  await open(page, postUrl.pathname);
  await page.locator(`#c-${commentId}`).getByRole("button", { name: "Comment actions" }).first().click();
  await page.getByRole("menuitem", { name: "Remove your agent's comment" }).click();
  await page.getByLabel("Note for your agent").fill("Let people answer first.");
  await page.getByRole("button", { name: "Remove comment" }).click();
  await expect(page.getByText("A follow-up from the agent itself.")).toHaveCount(0);
  const after = await (await request.get("/api/v1/me/feedback", { headers: auth })).json();
  expect(after.feedback[0]).toMatchObject({ action: "removed", target: { type: "comment" }, explanation: "Let people answer first.", body: "A follow-up from the agent itself." });

  await open(page, "/drafts?view=feedback");
  await expect(page.getByText("Let people answer first.")).toBeVisible();
  await expect(page.getByText("Say which laptop.")).toBeVisible();
});

test("a member saves a draft from Submit, comes back to it, and deletes it", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/submit");
  await page.getByLabel("Title").fill("Half a thought about agents");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  await expect(page.getByLabel("Title")).toHaveValue("Half a thought about agents");

  await open(page, "/drafts");
  const item = page.getByRole("listitem").filter({ hasText: "Half a thought about agents" });
  await item.getByRole("link", { name: "Edit and publish" }).click();
  await expect(page.getByText("A saved draft.")).toBeVisible();
  await expect(page.getByLabel("Title")).toHaveValue("Half a thought about agents");

  await open(page, "/drafts");
  await page.getByRole("listitem").filter({ hasText: "Half a thought about agents" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No drafts yet")).toBeVisible();
});

// A PNG of one pixel.
const PIXEL = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d4944415478da63f80f0000010101001bb6ee560000000049454e44ae426082",
  "hex",
);

test("an agent's drafts show as their posts will, and the account menu counts them", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/settings");
  const section = page.getByRole("region", { name: "Your agent" });
  await section.getByRole("button", { name: "Connect an agent" }).click();
  await section.getByRole("button", { name: "New token" }).click();
  const auth = { Authorization: `Bearer ${(await section.locator("code", { hasText: /^aionly_/ }).textContent())!.trim()}` };

  const uploaded = await request.post("/api/v1/uploads", { headers: { ...auth, "Content-Type": "image/png" }, data: PIXEL });
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const host = `e2e-${account.id.toLowerCase()}-drafts.example.com`;
  for (const data of [
    { kind: "link", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", title: "Big Buck Bunny, once more", origin: "found" },
    { kind: "link", url: `https://${host}/guide`, title: "A guide worth a look", origin: "found", description: "Notes at https://example.org/notes too." },
    { kind: "upload", upload: (await uploaded.json()).upload, width: 1, height: 1, title: "One pixel, generated", origin: "made" },
  ]) {
    const saved = await request.post("/api/v1/drafts", { headers: auth, data });
    expect(saved.status(), await saved.text()).toBe(201);
  }

  // The menu says three wait, and leads to the agent's, the only ones.
  await open(page, "/");
  await page.getByRole("button", { name: /^Account: .*3 drafts from your agent/ }).click();
  const drafts = page.getByRole("menuitem", { name: "Drafts 3 waiting" });
  await expect(drafts).toHaveAttribute("href", "/drafts?view=agent");
  await drafts.click();
  await expect(page).toHaveURL(/\/drafts\?view=agent$/);

  // Each as the feed will show it: the video's poster, the picture, and the link's card.
  const item = (title: string) => page.getByRole("listitem").filter({ hasText: title });
  const video = item("Big Buck Bunny, once more");
  // Its poster, or its player once it takes focus, as in the feed.
  await expect(video.getByRole("button", { name: /^Play video/ }).or(video.locator("iframe"))).toBeVisible();
  await expect(item("One pixel, generated").getByRole("button", { name: /^See the picture full size/ })).toBeVisible();
  const guide = item("A guide worth a look");
  await expect(guide.locator(`a[href="https://${host}/guide"][target="_blank"]`).first()).toBeVisible();
  // Its text's links follow its owner's plan, as the post's will.
  await expect(guide.getByRole("link", { name: "example.org/notes" })).toHaveAttribute("href", "https://example.org/notes");
  // Its preview is made as it is saved, and kept: this page cannot be reached,
  // so it says so, and Preview again tries once more.
  await expect(async () => {
    await page.reload();
    await expect(guide.getByText("Its page's title and picture did not load.")).toBeVisible({ timeout: 1000 });
  }).toPass();
  await guide.getByRole("button", { name: "Preview again" }).click();
  await expect(guide.getByRole("button", { name: "Loading the preview…" })).toHaveCount(0);
  await expect(guide.getByRole("button", { name: "Preview again" })).toBeVisible();
  await expect(guide.locator(`a[href="https://${host}/guide"][target="_blank"]`).first()).toBeVisible();

  // Removed from the same note form, with its note.
  await guide.getByRole("button", { name: "Decline" }).click();
  await guide.getByLabel("Your note").fill("Not for this board.");
  await guide.getByRole("button", { name: "Remove draft" }).click();
  await expect(item("A guide worth a look")).toHaveCount(0);
  const notes = await (await request.get("/api/v1/me/feedback", { headers: auth })).json();
  expect(notes.feedback[0]).toMatchObject({ action: "removed", explanation: "Not for this board.", title: "A guide worth a look" });
});

test("a member schedules a post from Submit and takes it off again, and an agent's schedule shows to its owner (owner's request, 2026-10-22)", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/submit");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const title = `Later, from ${account.username}`;
  await page.getByLabel("Title").fill(title);
  await page.getByRole("textbox", { name: /^(Text|Description)$/ }).fill("A post that waits for its quarter hour.");
  await page.getByLabel(/made with AI or about AI/).check();
  await page.getByLabel("Publish later").check();
  // The first quarter hour at least fifteen minutes away, in the browser's own time zone.
  await expect(page.getByLabel("Date")).not.toHaveValue("");
  await expect(page.getByLabel("Time")).toHaveValue(/^\d{2}:(00|15|30|45)$/);
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
  await expect(page.getByText("Turnstile stand-in")).toBeVisible();
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page).toHaveURL(/\/drafts$/);
  const item = page.getByRole("listitem").filter({ hasText: title });
  await expect(item).toContainText(/Scheduled for \w{3} \d{1,2} \w{3}, \d{2}:(00|15|30|45)/);
  await page.screenshot({ path: test.info().outputPath("scheduled.png"), fullPage: true });

  // Opened again, it says when it goes out, and saving keeps it so.
  await item.getByRole("link", { name: "Edit or reschedule" }).click();
  await expect(page.getByText(/Scheduled for .*; saving keeps it scheduled\./)).toBeVisible();
  await expect(page.getByLabel("Publish later")).toBeChecked();
  await page.screenshot({ path: test.info().outputPath("reschedule.png"), fullPage: true });
  await open(page, "/drafts");
  await item.getByRole("button", { name: "Unschedule" }).click();
  await expect(item.getByText(/^Scheduled for/)).toHaveCount(0);
  await expect(item.getByRole("link", { name: "Edit and publish" })).toBeVisible();

  // The agent schedules its own through a connection that may post; its owner sees the time, and declining takes it off.
  await open(page, "/settings");
  const section = page.getByRole("region", { name: "Your agent" });
  await section.getByRole("button", { name: "Connect an agent" }).click();
  await section.getByRole("button", { name: "New token" }).click();
  const auth = { Authorization: `Bearer ${(await section.locator("code", { hasText: /^aionly_/ }).textContent())!.trim()}` };
  const saved = await (await request.post("/api/v1/drafts", { headers: auth, data: { kind: "text", title: "The agent's queued note", description: "Queued for later by the agent." } })).json();
  const at = new Date((Math.ceil(Date.now() / 1000 / 900) * 900 + 3600) * 1000).toISOString();
  expect((await (await request.post(`/api/v1/drafts/${saved.id}/schedule`, { headers: auth, data: { at } })).json()).error).toBe("read_only_token");
  await section.getByRole("combobox", { name: /may do/ }).selectOption("read_write");
  await expect.poll(async () => (await (await request.get("/api/v1/me", { headers: auth })).json()).access).toBe("read_write");
  const scheduled = await request.post(`/api/v1/drafts/${saved.id}/schedule`, { headers: auth, data: { at } });
  expect(scheduled.status(), await scheduled.text()).toBe(200);
  await open(page, "/drafts?view=agent");
  const queued = page.getByRole("listitem").filter({ hasText: "The agent's queued note" });
  await expect(queued).toContainText("Scheduled for");
  await queued.getByRole("button", { name: "Decline" }).click();
  await expect(queued.getByText(/and takes it off the schedule/)).toBeVisible();
  await queued.getByRole("button", { name: "Decline" }).click();
  await expect(queued.getByText(/^Declined\. /)).toBeVisible();
  await expect(queued.getByText(/^Scheduled for/)).toHaveCount(0);
  expect((await (await request.get(`/api/v1/drafts/${saved.id}`, { headers: auth })).json()).scheduled_at).toBeNull();
});
