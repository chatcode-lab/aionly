import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accountRecord } from "../../app/lib/db/accounts.server";
import { findDuplicate, postingStatus, publishPost, type NewPost } from "../../app/lib/db/submit.server";
import { imageAccess, setGooglePhoto, sniffImage, snapshotImage, sweepPendingImages } from "../../app/lib/images.server";
import { fetchPublic, FetchRefused } from "../../app/lib/links/fetch.server";
import { readPageMeta } from "../../app/lib/links/metadata.server";
import { verifyTurnstile } from "../../app/lib/security/turnstile.server";
import { checkLink } from "../../app/lib/submit/check.server";
import { readReceipt, signReceipt } from "../../app/lib/submit/receipt.server";
import { DAY, db, NOW, post, reset, user } from "./fixtures";

const bucket = env.IMAGES;
const SECRET = "test-secret-for-receipts-0123456789";
const OWN = ["aion.ly"];

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Answers outbound fetches by address; anything unexpected is a failure. */
function stubFetch(routes: Record<string, Route>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = Object.keys(routes).find((prefix) => url.href.startsWith(prefix));
    if (!key) throw new Error(`unexpected fetch: ${url.href}`);
    return routes[key](url, init);
  });
}

const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
const json = (value: unknown) => Response.json(value);
const image = (bytes: Uint8Array<ArrayBuffer>, type = "image/jpeg") => new Response(bytes, { headers: { "Content-Type": type } });

beforeEach(async () => {
  await reset();
  await db.prepare(`DELETE FROM images`).run();
  const listed = await bucket.list();
  if (listed.objects.length) await bucket.delete(listed.objects.map((object) => object.key));
  await user("u1", "quiet_otter_482");
  await user("u2", "paper_lark_17");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readPageMeta", () => {
  it("prefers Open Graph, falls back to Twitter tags and the title, and decodes entities", async () => {
    const page = new TextEncoder().encode(`<html><head><title>Plain &amp; simple</title>
      <meta property="og:title" content="Rock &amp; roll &#x2014; live">
      <meta name="twitter:image" content="/img/card.png">
      </head><body></body></html>`);
    expect(await readPageMeta(page, new URL("https://example.com/a/b"), OWN)).toEqual({
      title: "Rock & roll — live",
      image: new URL("https://example.com/img/card.png"),
    });
    const bare = new TextEncoder().encode(`<title>
      Just   a title</title>`);
    expect(await readPageMeta(bare, new URL("https://example.com/"), OWN)).toEqual({ title: "Just a title", image: undefined });
  });

  it("ignores images that are not public https addresses", async () => {
    const page = new TextEncoder().encode(`<meta property="og:image" content="http://example.com/a.png">`);
    expect((await readPageMeta(page, new URL("https://example.com/"), OWN)).image).toBeUndefined();
    const local = new TextEncoder().encode(`<meta property="og:image" content="https://127.0.0.1/a.png">`);
    expect((await readPageMeta(local, new URL("https://example.com/"), OWN)).image).toBeUndefined();
  });
});

describe("fetchPublic", () => {
  it("follows redirects only to public https addresses", async () => {
    stubFetch({
      "https://short.example.com/": () => new Response(null, { status: 302, headers: { Location: "https://example.com/final" } }),
      "https://example.com/final": () => html("ok"),
      "https://bad.example.com/": () => new Response(null, { status: 301, headers: { Location: "http://localhost/admin" } }),
      "https://own.example.com/": () => new Response(null, { status: 301, headers: { Location: "https://aion.ly/x" } }),
    });
    const signal = AbortSignal.timeout(1000);
    const { finalUrl } = await fetchPublic(new URL("https://short.example.com/x"), { accept: "text/html", signal, ownHosts: OWN });
    expect(finalUrl.href).toBe("https://example.com/final");
    await expect(fetchPublic(new URL("https://bad.example.com/"), { accept: "text/html", signal, ownHosts: OWN })).rejects.toBeInstanceOf(FetchRefused);
    await expect(fetchPublic(new URL("https://own.example.com/"), { accept: "text/html", signal, ownHosts: OWN })).rejects.toBeInstanceOf(FetchRefused);
  });

  it("gives up after four redirects", async () => {
    stubFetch({ "https://loop.example.com/": (url) => new Response(null, { status: 302, headers: { Location: `${url.href}x` } }) });
    await expect(
      fetchPublic(new URL("https://loop.example.com/"), { accept: "text/html", signal: AbortSignal.timeout(1000), ownHosts: OWN }),
    ).rejects.toThrow("too many redirects");
  });
});

describe("snapshots", () => {
  it("recognizes JPEG, PNG, and WebP by their bytes, and nothing else", () => {
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBeNull();
  });

  it("keeps one pending image per account, replacing the last", async () => {
    stubFetch({ "https://img.example.com/": () => image(JPEG, "text/plain") });
    const take = () =>
      snapshotImage(db, bucket, { ownerId: "u1", url: new URL("https://img.example.com/a.jpg"), signal: AbortSignal.timeout(1000), ownHosts: OWN, now: NOW });
    const first = await take();
    const second = await take();
    expect(first).toMatch(/^[0-9A-Za-z]{24}$/);
    expect(second).not.toBe(first);
    expect(await bucket.get(first!)).toBeNull();
    const stored = await bucket.get(second!);
    expect(stored?.httpMetadata?.contentType).toBe("image/jpeg");
    const rows = await db.prepare(`SELECT key FROM images WHERE owner_id = 'u1'`).all();
    expect(rows.results).toEqual([{ key: second }]);
  });

  it("refuses pictures that are too large or not images", async () => {
    stubFetch({
      "https://img.example.com/big": () => new Response(new Uint8Array(3 * 1024 * 1024), { headers: { "Content-Length": String(3 * 1024 * 1024) } }),
      "https://img.example.com/page": () => html("<html>not an image</html>"),
    });
    const take = (path: string) =>
      snapshotImage(db, bucket, { ownerId: "u1", url: new URL(`https://img.example.com/${path}`), signal: AbortSignal.timeout(1000), ownHosts: OWN, now: NOW });
    expect(await take("big")).toBeNull();
    expect(await take("page")).toBeNull();
    expect((await bucket.list()).objects).toHaveLength(0);
  });

  it("serves a pending image to its owner only, and an attached one while its post is live", async () => {
    stubFetch({ "https://img.example.com/": () => image(PNG) });
    const key = (await snapshotImage(db, bucket, { ownerId: "u1", url: new URL("https://img.example.com/a.png"), signal: AbortSignal.timeout(1000), ownHosts: OWN, now: NOW }))!;
    expect(await imageAccess(db, key, "u1")).toEqual({ visible: true, public: false, contentType: "image/png" });
    expect(await imageAccess(db, key, "u2")).toEqual({ visible: false });
    expect(await imageAccess(db, key, null)).toEqual({ visible: false });

    const author = (await accountRecord(db, "u1", NOW))!;
    const result = await publishPost(db, newPost(author, { thumbKey: key }));
    expect(result.ok).toBe(true);
    expect(await imageAccess(db, key, null)).toEqual({ visible: true, public: true, contentType: "image/png" });

    await db.prepare(`UPDATE posts SET removed_batch_id = 'b1'`).run();
    expect(await imageAccess(db, key, null)).toEqual({ visible: false });
    expect(await imageAccess(db, key, "u1")).toEqual({ visible: false });
  });

  it("sweeps pending images older than a day", async () => {
    stubFetch({ "https://img.example.com/": () => image(JPEG) });
    const key = (await snapshotImage(db, bucket, { ownerId: "u1", url: new URL("https://img.example.com/a.jpg"), signal: AbortSignal.timeout(1000), ownHosts: OWN, now: NOW }))!;
    expect(await sweepPendingImages(db, bucket, NOW + DAY - 1)).toBe(0);
    expect(await sweepPendingImages(db, bucket, NOW + DAY + 1)).toBe(1);
    expect(await bucket.get(key)).toBeNull();
    expect(await imageAccess(db, key, "u1")).toEqual({ visible: false });
  });
});

describe("receipts", () => {
  const receipt = {
    userId: "u1",
    url: "https://example.com/a",
    canonicalKey: "url:example.com/a",
    provider: null,
    aspect: null,
    pageTitle: "A page",
    thumbKey: null,
    expiresAt: NOW + 100,
  };

  it("holds for its own account until it expires", async () => {
    const token = await signReceipt(receipt, SECRET);
    expect(await readReceipt(token, SECRET, "u1", NOW)).toEqual(receipt);
    expect(await readReceipt(token, SECRET, "u2", NOW)).toBeNull();
    expect(await readReceipt(token, SECRET, "u1", NOW + 100)).toBeNull();
    expect(await readReceipt(token, "another-secret", "u1", NOW)).toBeNull();
  });

  it("refuses any change to its contents", async () => {
    const token = await signReceipt(receipt, SECRET);
    const [payload, signature] = token.split(".");
    const forged = btoa(JSON.stringify({ ...receipt, url: "https://evil.example.com/" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await readReceipt(`${forged}.${signature}`, SECRET, "u1", NOW)).toBeNull();
    expect(await readReceipt(`${payload}.${signature}x`, SECRET, "u1", NOW)).toBeNull();
    expect(await readReceipt(`${payload}`, SECRET, "u1", NOW)).toBeNull();
  });
});

describe("verifyTurnstile", () => {
  it("answers Cloudflare's test secrets without a request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const check = (secret: string) =>
      verifyTurnstile({ secret, token: "XXXX.DUMMY.TOKEN.XXXX", remoteIp: null, hostname: "aion.ly", action: "submit" });
    expect(await check("1x0000000000000000000000000000000AA")).toBe(true);
    expect(await check("2x0000000000000000000000000000000AA")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires success, this hostname, and this action", async () => {
    let answer: Record<string, unknown> = {};
    stubFetch({ "https://challenges.cloudflare.com/": () => json(answer) });
    const check = () =>
      verifyTurnstile({ secret: "0x4real-secret", token: "token", remoteIp: "1.2.3.4", hostname: "aion.ly", action: "submit" });
    answer = { success: true, hostname: "aion.ly", action: "submit" };
    expect(await check()).toBe(true);
    answer = { success: true, hostname: "evil.example.com", action: "submit" };
    expect(await check()).toBe(false);
    answer = { success: true, hostname: "aion.ly", action: "login" };
    expect(await check()).toBe(false);
    answer = { success: false, hostname: "aion.ly", action: "submit" };
    expect(await check()).toBe(false);
  });
});

function newPost(author: NonNullable<Awaited<ReturnType<typeof accountRecord>>>, fields: Partial<NewPost> = {}): NewPost {
  return {
    id: fields.id ?? `new${Math.random().toString(36).slice(2, 8)}`,
    author,
    url: "https://example.com/new",
    canonicalKey: "url:example.com/new",
    provider: null,
    aspect: null,
    pageTitle: null,
    thumbKey: null,
    origin: "found",
    title: "A new post",
    description: "Long enough to be a description.",
    now: NOW,
    ...fields,
  };
}

describe("posting", () => {
  it("allows one publication per rolling day, counting deleted posts", async () => {
    const author = (await accountRecord(db, "u1", NOW))!;
    expect(await postingStatus(db, author, NOW)).toEqual({ allowed: true });
    expect(await publishPost(db, newPost(author, { id: "first" }))).toEqual({ ok: true, id: "first" });
    await db.prepare(`UPDATE posts SET deleted_at = ?1 WHERE id = 'first'`).bind(NOW + 1).run();

    expect(await postingStatus(db, author, NOW + 3600)).toEqual({ allowed: false, reason: "wait", nextAt: NOW + DAY });
    expect(
      await publishPost(db, newPost(author, { id: "second", canonicalKey: "url:example.com/2", now: NOW + 3600 })),
    ).toEqual({ ok: false, reason: "not_allowed" });
    expect(await postingStatus(db, author, NOW + DAY)).toEqual({ allowed: true });
  });

  it("pauses posting below zero karma, except for admins", async () => {
    await db.prepare(`UPDATE profiles SET karma = -1 WHERE user_id = 'u1'`).run();
    const author = (await accountRecord(db, "u1", NOW))!;
    expect(await postingStatus(db, author, NOW)).toEqual({ allowed: false, reason: "karma" });
    expect((await publishPost(db, newPost(author))).ok).toBe(false);

    await db.prepare(`UPDATE profiles SET role = 'admin' WHERE user_id = 'u1'`).run();
    const admin = (await accountRecord(db, "u1", NOW))!;
    expect(await postingStatus(db, admin, NOW)).toEqual({ allowed: true });
    expect((await publishPost(db, newPost(admin, { id: "a1" }))).ok).toBe(true);
    expect((await publishPost(db, newPost(admin, { id: "a2", canonicalKey: "url:example.com/a2" }))).ok).toBe(true);
  });

  it("honors a per-account limit an admin set, for that account only", async () => {
    await db.prepare(`UPDATE profiles SET limits = '{"postsPerDay":3}' WHERE user_id = 'u1'`).run();
    const raised = (await accountRecord(db, "u1", NOW))!;
    for (const n of [1, 2, 3]) {
      expect((await publishPost(db, newPost(raised, { id: `r${n}`, canonicalKey: `url:example.com/r${n}` }))).ok).toBe(true);
    }
    expect((await publishPost(db, newPost(raised, { id: "r4", canonicalKey: "url:example.com/r4" }))).ok).toBe(false);

    const other = (await accountRecord(db, "u2", NOW))!;
    expect((await publishPost(db, newPost(other, { id: "o1", canonicalKey: "url:example.com/o1" }))).ok).toBe(true);
    expect((await publishPost(db, newPost(other, { id: "o2", canonicalKey: "url:example.com/o2" }))).ok).toBe(false);

    await db.prepare(`UPDATE profiles SET limits = '{"postsPerDay":null}' WHERE user_id = 'u2'`).run();
    const lifted = (await accountRecord(db, "u2", NOW))!;
    expect((await publishPost(db, newPost(lifted, { id: "o3", canonicalKey: "url:example.com/o3" }))).ok).toBe(true);
  });

  it("refuses a duplicate without using the allowance, and keeps a removed link blocked", async () => {
    await post("old", { author: "u2", key: "url:example.com/new" });
    const author = (await accountRecord(db, "u1", NOW))!;
    expect(await publishPost(db, newPost(author))).toEqual({
      ok: false,
      reason: "duplicate",
      existing: { id: "old", state: "live" },
    });
    expect(await postingStatus(db, author, NOW)).toEqual({ allowed: true });

    await db.prepare(`UPDATE posts SET removed_batch_id = 'b1' WHERE id = 'old'`).run();
    expect(await findDuplicate(db, "url:example.com/new")).toEqual({ id: "old", state: "removed" });
    // Only an author-deleted, unremoved post frees its link.
    await db.prepare(`UPDATE posts SET removed_batch_id = NULL, deleted_at = ?1 WHERE id = 'old'`).bind(NOW).run();
    expect(await findDuplicate(db, "url:example.com/new")).toBeNull();
    expect((await publishPost(db, newPost(author, { id: "fresh" }))).ok).toBe(true);
  });

  it("refuses a banned author inside the write", async () => {
    const author = (await accountRecord(db, "u1", NOW))!;
    await db.prepare(`UPDATE profiles SET banned_at = ?1 WHERE user_id = 'u1'`).bind(NOW).run();
    expect(await publishPost(db, newPost(author))).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("attaches only the author's own pending image", async () => {
    stubFetch({ "https://img.example.com/": () => image(JPEG) });
    const theirs = (await snapshotImage(db, bucket, { ownerId: "u2", url: new URL("https://img.example.com/a.jpg"), signal: AbortSignal.timeout(1000), ownHosts: OWN, now: NOW }))!;
    const author = (await accountRecord(db, "u1", NOW))!;
    expect((await publishPost(db, newPost(author, { id: "p1", thumbKey: theirs }))).ok).toBe(true);
    const row = await db.prepare(`SELECT thumb_key FROM posts WHERE id = 'p1'`).first<{ thumb_key: string | null }>();
    expect(row?.thumb_key).toBeNull();
    expect(await imageAccess(db, theirs, "u2")).toMatchObject({ visible: true, public: false });
  });
});

describe("checkLink", () => {
  const check = (raw: string) =>
    checkLink({ raw, userId: "u1", ownHosts: OWN, db, bucket, secret: SECRET, now: NOW });

  it("explains links that cannot be posted", async () => {
    expect(await check("http://example.com/")).toEqual({ ok: false, error: "Only https links can be posted." });
    expect(await check("https://aion.ly/p/x")).toEqual({ ok: false, error: "Links to this board can't be posted." });
    expect(await check("https://localhost/")).toEqual({ ok: false, error: "That address isn't on the public web." });
  });

  it("previews a YouTube video from its oEmbed and thumbnail, with a clean address", async () => {
    stubFetch({
      "https://www.youtube.com/oembed": (url) => {
        expect(url.searchParams.get("url")).toBe("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
        return json({ title: "Big Buck Bunny 60fps 4K" });
      },
      "https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg": () => image(JPEG),
    });
    const result = await check("https://youtu.be/aqz-KE-bpKQ?si=share");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.link).toMatchObject({
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      host: "youtube.com",
      provider: "youtube",
      aspect: "16:9",
      pageTitle: null,
      suggestedTitle: "Big Buck Bunny 60fps 4K",
    });
    expect(result.link.thumbUrl).toMatch(/^\/img\/[0-9A-Za-z]{24}$/);
    const receipt = await readReceipt(result.receipt!, SECRET, "u1", NOW);
    expect(receipt).toMatchObject({ canonicalKey: "youtube:aqz-KE-bpKQ", provider: "youtube" });
  });

  it("previews a page from its Open Graph tags, and still checks when they fail", async () => {
    stubFetch({
      "https://example.com/ok": () =>
        html(`<meta property="og:title" content="A tool"><meta property="og:image" content="https://cdn.example.com/c.png">`),
      "https://cdn.example.com/": () => image(PNG),
      "https://example.com/down": () => new Response("no", { status: 503 }),
    });
    const ok = await check("https://example.com/ok?utm_source=x");
    expect(ok.ok && ok.link).toMatchObject({ url: "https://example.com/ok", pageTitle: "A tool", suggestedTitle: "A tool" });
    const down = await check("https://example.com/down");
    expect(down.ok && down.link).toMatchObject({ url: "https://example.com/down", pageTitle: null, thumbUrl: null });
    expect(down.ok && down.receipt).toBeTruthy();
  });

  it("follows a provider's short link to the post it names", async () => {
    stubFetch({
      "https://vm.tiktok.com/": () =>
        new Response(null, { status: 301, headers: { Location: "https://www.tiktok.com/@scout2015/video/6718335390845095173?_r=1" } }),
      "https://www.tiktok.com/@scout2015/": () => html(""),
      "https://www.tiktok.com/oembed": () => json({ title: "Scramble up ur name" }),
    });
    const result = await check("https://vm.tiktok.com/ZMabc123/");
    expect(result.ok && result.link).toMatchObject({
      url: "https://www.tiktok.com/@scout2015/video/6718335390845095173",
      provider: "tiktok",
      aspect: "9:16",
    });
  });

  it("reports a duplicate without fetching anything", async () => {
    await post("old", { author: "u2", key: "youtube:aqz-KE-bpKQ" });
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await check("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
    expect(result).toMatchObject({ ok: true, duplicate: { id: "old", state: "live" }, receipt: null });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Google photo", () => {
  const signedUp = (image: string | null) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
         VALUES ('u1', 'Private Name', 'private@example.com', 1, ?1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .bind(image)
      .run();
  const avatarKey = async () =>
    (await db.prepare(`SELECT avatar_key FROM profiles WHERE user_id = 'u1'`).first<{ avatar_key: string | null }>())?.avatar_key;
  const set = (on: boolean) => setGooglePhoto(db, bucket, { userId: "u1", on, ownHosts: OWN, now: NOW });

  it("keeps a copy as the avatar, served to everyone, and deletes it when turned off", async () => {
    await signedUp("https://lh3.googleusercontent.com/a/photo=s96-c");
    stubFetch({ "https://lh3.googleusercontent.com/": () => image(JPEG) });
    expect(await set(true)).toEqual({ ok: true });
    const key = (await avatarKey())!;
    expect(key).toMatch(/^[0-9A-Za-z]{24}$/);
    expect(await imageAccess(db, key, null)).toEqual({ visible: true, public: true, contentType: "image/jpeg" });

    // Turning it on again replaces the copy.
    expect(await set(true)).toEqual({ ok: true });
    const second = (await avatarKey())!;
    expect(second).not.toBe(key);
    expect(await bucket.get(key)).toBeNull();

    expect(await set(false)).toEqual({ ok: true });
    expect(await avatarKey()).toBeNull();
    expect(await bucket.get(second)).toBeNull();
    expect(await imageAccess(db, second, null)).toEqual({ visible: false });
  });

  it("says when there is no photo, or it cannot be copied", async () => {
    await signedUp(null);
    expect(await set(true)).toEqual({ ok: false, reason: "no_photo" });
    await signedUp("https://lh3.googleusercontent.com/a/photo");
    stubFetch({ "https://lh3.googleusercontent.com/": () => html("<html>") });
    expect(await set(true)).toEqual({ ok: false, reason: "failed" });
    expect(await avatarKey()).toBeNull();
  });

  it("refuses a banned account and keeps nothing", async () => {
    await signedUp("https://lh3.googleusercontent.com/a/photo");
    stubFetch({ "https://lh3.googleusercontent.com/": () => image(PNG) });
    await db.prepare(`UPDATE profiles SET banned_at = ?1 WHERE user_id = 'u1'`).bind(NOW).run();
    expect(await set(true)).toEqual({ ok: false, reason: "failed" });
    expect((await bucket.list()).objects).toHaveLength(0);
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM images`).first<{ n: number }>())?.n).toBe(0);
  });
});
