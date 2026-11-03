import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pictures are on the media domain, as deployed, so they can be resized.
vi.mock("../../app/lib/media.server", () => ({ imageAddress: (key: string) => `https://media.aion.ly/${key}` }));

import { tendChannel } from "../../app/lib/telegram/channel.server";
import { DAY, db, NOW, post, reset, user } from "./fixtures";

const HOUR = 3600;
const MB = 1024 * 1024;
const OLD_ENOUGH = 7 * HOUR;

interface Call {
  method: string;
  body: Record<string, unknown>;
  /** What a message sent with a file carried in it. */
  form?: FormData;
}

const calls: Call[] = [];
/** What Telegram answers next, by method; the default is that it took the message. */
let answer: (call: Call) => unknown;
let nextId = 100;
let logged: ReturnType<typeof vi.spyOn>;

const sendsOk = (): unknown => ({ ok: true, result: { message_id: (nextId += 1) } });
const bucket = (size = MB, stored = true) =>
  ({
    head: async () => (stored ? { size } : null),
    get: async () => (stored ? { arrayBuffer: async () => new ArrayBuffer(8) } : null),
  }) as unknown as R2Bucket;

const tend = (at = NOW, files = bucket()) => tendChannel(db, files, { token: "secret-token", channel: "1234567890", origin: "https://aion.ly", now: at });

const sends = () => calls.filter((call) => call.method.startsWith("send"));
const row = (id: string) =>
  db.prepare(`SELECT * FROM channel_posts WHERE post_id = ?1`).bind(id).first<{
    message_id: number | null;
    sent_at: number | null;
    failure: string | null;
    retracted_at: number | null;
  }>();
const fields = (id: string, set: string, ...values: unknown[]) => db.prepare(`UPDATE posts SET ${set} WHERE id = ?1`).bind(id, ...values).run();

beforeEach(async () => {
  await reset();
  await user("u1", "aisha");
  calls.length = 0;
  nextId = 100;
  answer = sendsOk;
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const name = String(input).split("/").at(-1)!;
    const form = init?.body instanceof FormData ? init.body : undefined;
    const call: Call = { method: name, body: form ? {} : (JSON.parse(String(init?.body)) as Record<string, unknown>), ...(form ? { form } : {}) };
    calls.push(call);
    return Response.json(answer(call));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what goes to the channel", () => {
  it("sends the top post, to the channel's full ID, and keeps its message", async () => {
    await post("low", { score: 2, age: OLD_ENOUGH });
    await post("top", { score: 9, age: OLD_ENOUGH });
    await tend();
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.body.chat_id).toBe("-1001234567890");
    expect(JSON.stringify(sends()[0]!.body)).toContain("Title of top");
    expect(await row("top")).toMatchObject({ message_id: 101, sent_at: NOW, failure: null });
    expect(await row("low")).toBeNull();
  });

  it("breaks a tie as Top does, by the newest", async () => {
    await post("older", { score: 3, age: OLD_ENOUGH + HOUR });
    await post("newer", { score: 3, age: OLD_ENOUGH });
    await tend();
    expect(await row("newer")).not.toBeNull();
  });

  it("leaves a post too new, too old, voted down, deleted, or removed", async () => {
    await post("fresh", { score: 9, age: HOUR });
    await post("stale", { score: 9, age: 8 * DAY });
    await post("down", { score: 0, age: OLD_ENOUGH });
    await post("gone", { score: 9, age: OLD_ENOUGH, deleted: true });
    await post("taken", { score: 9, age: OLD_ENOUGH, removed: true });
    await tend();
    expect(calls).toHaveLength(0);
  });

  it("sends nothing while the last post is under six hours old, then the next", async () => {
    await post("first", { score: 9, age: OLD_ENOUGH });
    await post("second", { score: 5, age: OLD_ENOUGH });
    await tend();
    await tend(NOW + 5 * HOUR);
    expect(sends()).toHaveLength(1);
    await tend(NOW + 6 * HOUR);
    expect(sends()).toHaveLength(2);
    expect(await row("second")).toMatchObject({ sent_at: NOW + 6 * HOUR });
  });

  it("forgives a run that starts a moment early, so a turn stays six hours", async () => {
    await post("first", { score: 9, age: OLD_ENOUGH });
    await post("second", { score: 5, age: OLD_ENOUGH });
    await tend();
    await tend(NOW + 6 * HOUR - 30);
    expect(sends()).toHaveLength(2);
  });

  it("never sends a post twice", async () => {
    await post("only", { score: 9, age: OLD_ENOUGH });
    await tend();
    await tend(NOW + 12 * HOUR);
    await tend(NOW + 24 * HOUR);
    expect(sends()).toHaveLength(1);
  });
});

describe("how a post is shown", () => {
  it("sends a link post as a plain message over its preview", async () => {
    await post("link", { score: 9, age: OLD_ENOUGH, url: "https://www.youtube.com/watch?v=abc", provider: "youtube", aspect: "16:9" });
    await tend();
    expect(sends()[0]!.method).toBe("sendMessage");
    expect(sends()[0]!.body.link_preview_options).toEqual({ url: "https://www.youtube.com/watch?v=abc", prefer_large_media: true });
  });

  it("sends a gallery as resized copies in one rich message", async () => {
    await post("album", { score: 9, age: OLD_ENOUGH });
    const pictures = [
      { key: "aaaaaaaaaaaaaaaaaaaaaaaa.jpg", width: 900, height: 600 },
      { key: "bbbbbbbbbbbbbbbbbbbbbbbb.gif", width: 400, height: 300 },
    ];
    await fields("album", `kind = 'upload', url = NULL, media_key = ?2, media_type = 'image', media_width = 900, media_height = 600, pictures = ?3`, pictures[0]!.key, JSON.stringify(pictures));
    await tend();
    const html = (sends()[0]!.body.rich_message as { html: string }).html;
    expect(html).toContain("<tg-slideshow><img src=\"https://media.aion.ly/cdn-cgi/image/width=1600,height=2560,fit=scale-down,format=baseline-jpeg,onerror=redirect/aaaaaaaaaaaaaaaaaaaaaaaa.jpg\"/>");
    expect(html).toContain(`<video src="https://media.aion.ly/bbbbbbbbbbbbbbbbbbbbbbbb.gif"></video>`);
    expect(html).toContain("<footer>Gallery · by");
  });

  async function video(key: string, poster = true) {
    await post("clip", { score: 9, age: OLD_ENOUGH });
    await fields("clip", `kind = 'upload', url = NULL, media_key = ?2, media_type = 'video', media_width = 1280, media_height = 720, media_duration = 14, thumb_key = ?3`, key, poster ? "poster.jpg" : null);
  }

  it("lets Telegram fetch an MP4 up to 20 MB", async () => {
    await video("clip.mp4");
    await tend(NOW, bucket(20 * MB));
    const [attached] = (sends()[0]!.body.rich_message as { media: { media: Record<string, unknown> }[] }).media;
    expect(attached!.media).toMatchObject({ media: "https://media.aion.ly/clip.mp4", cover: "https://media.aion.ly/poster.jpg", width: 1280, height: 720, duration: 14 });
    expect(sends()[0]!.form).toBeUndefined();
  });

  it("sends an MP4 past 20 MB with the message, its size stated", async () => {
    await video("clip.mp4");
    await tend(NOW, bucket(21 * MB));
    const { form } = sends()[0]!;
    expect(form?.get("chat_id")).toBe("-1001234567890");
    expect((form?.get("clipfile") as File).type).toBe("video/mp4");
    expect(form?.get("rich_message")).toContain(`"media":"attach://clipfile"`);
    expect(form?.get("rich_message")).toContain(`"width":1280`);
    expect(JSON.parse(form?.get("reply_markup") as string).inline_keyboard[0][0].text).toBe("Read more");
    expect(form?.get("disable_notification")).toBe("true");
  });

  it("shows a WebM's poster, which Telegram refuses as a video", async () => {
    await video("clip.webm");
    await tend();
    const html = (sends()[0]!.body.rich_message as { html: string }).html;
    expect(html).toContain("/poster.jpg\"/><h3>");
    expect(html).not.toContain("<video");
  });

  it("shows a large video of unknown size by its poster, as Telegram would draw it square", async () => {
    await video("clip.mp4");
    await fields("clip", `media_width = NULL, media_height = NULL`);
    await tend(NOW, bucket(21 * MB));
    expect((sends()[0]!.body.rich_message as { html: string }).html).not.toContain("<video");
  });

  it("names the board, as a link to the post, for a text post that leads nowhere", async () => {
    await post("words", { score: 9, age: OLD_ENOUGH, description: "**TL;DR:** It works." });
    await fields("words", `kind = 'text', url = NULL`);
    await tend();
    const html = (sends()[0]!.body.rich_message as { html: string }).html;
    expect(html).toContain(`<footer><a href="https://aion.ly/p/words`);
    expect(html).toContain(`">aion.ly</a> · by 👤`);
    expect(html).toContain("<p><b>TL;DR:</b> It works.</p>");
  });

  it("shows what a text post's card shows, with its picture's caption", async () => {
    const key = "cccccccccccccccccccccccc.png";
    await post("article", { score: 9, age: OLD_ENOUGH, description: `Words.\n\n![The plate](upload:${key} "Via the archive")` });
    await fields(
      "article",
      `kind = 'text', url = NULL, inline_media = ?2, card_preview = ?3`,
      JSON.stringify([{ key, type: "image", width: 800, height: 600 }]),
      JSON.stringify({ upload: key, alt: "The plate" }),
    );
    await tend();
    const html = (sends()[0]!.body.rich_message as { html: string }).html;
    expect(html).toContain(`/${key}"/><figcaption>Via the archive</figcaption></figure><h3>`);
    expect(html.match(/<p>.*<\/p>/)![0]).toBe("<p>Words.</p>");
  });

  it("leaves out the preview of an author who chose none", async () => {
    await post("plain", { score: 9, age: OLD_ENOUGH });
    await fields("plain", `kind = 'text', url = NULL, card_preview = ?2, card_preview_shown = 0`, JSON.stringify({ link: "https://example.org/x", title: "X" }));
    await tend();
    expect(sends()[0]!.method).toBe("sendRichMessage");
    expect((sends()[0]!.body.rich_message as { html: string }).html).toMatch(/^<h3>/);
  });
});

describe("when Telegram does not take a post", () => {
  const refuse = (description: string) => ({ ok: false, error_code: 400, description: `Bad Request: ${description}` });

  it("falls back on less media, as it refuses a whole message over its media", async () => {
    await post("clip", { score: 9, age: OLD_ENOUGH });
    await fields("clip", `kind = 'upload', url = NULL, media_key = 'clip.mp4', media_type = 'video', thumb_key = 'poster.jpg'`);
    let tries = 0;
    answer = () => ((tries += 1) < 3 ? refuse("failed to get HTTP URL content") : sendsOk());
    await tend();
    expect(sends()).toHaveLength(3);
    expect(await row("clip")).toMatchObject({ message_id: 101, failure: null });
  });

  it("gives up on a post refused every way, and tries the next within the hour", async () => {
    await post("bad", { score: 9, age: OLD_ENOUGH });
    await post("good", { score: 5, age: OLD_ENOUGH });
    answer = () => refuse("something about this post");
    await tend();
    expect(await row("bad")).toMatchObject({ message_id: null, failure: "Bad Request: something about this post" });
    answer = sendsOk;
    await tend(NOW + HOUR);
    expect(await row("good")).toMatchObject({ sent_at: NOW + HOUR });
  });

  it("gives back the claim when Telegram is busy or unwell, and stops", async () => {
    await post("wait", { score: 9, age: OLD_ENOUGH });
    for (const refusal of [
      { ok: false, error_code: 429, description: "Too Many Requests" },
      { ok: false, error_code: 502, description: "Bad Gateway" },
    ]) {
      answer = () => refusal;
      calls.length = 0;
      await tend();
      expect(sends()).toHaveLength(1);
      expect(await row("wait")).toBeNull();
    }
  });

  it("does not spend posts on a bot or channel that is set up wrong", async () => {
    await post("wait", { score: 9, age: OLD_ENOUGH });
    for (const refusal of [
      { ok: false, error_code: 401, description: "Unauthorized" },
      { ok: false, error_code: 403, description: "Forbidden: bot is not a member of the channel chat" },
      refuse("chat not found"),
    ]) {
      answer = () => refusal;
      await tend();
      expect(await row("wait")).toBeNull();
    }
  });

  it("counts a send with no answer as sent rather than risk it twice, and never logs the token", async () => {
    await post("maybe", { score: 9, age: OLD_ENOUGH });
    vi.mocked(fetch).mockRejectedValueOnce(new Error("failed: https://api.telegram.org/botsecret-token/sendMessage"));
    await tend();
    const kept = await row("maybe");
    expect(kept).toMatchObject({ message_id: null });
    expect(kept!.failure).not.toContain("secret-token");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-token");
    await tend(NOW + HOUR);
    expect(calls).toHaveLength(0);
  });

  it("leaves a claim a run did not finish, rather than risk a post twice", async () => {
    await post("cut", { score: 9, age: OLD_ENOUGH });
    await db.prepare(`INSERT INTO channel_posts (post_id, claimed_at) VALUES ('cut', ?1)`).bind(NOW - HOUR).run();
    await tend();
    expect(calls).toHaveLength(0);
  });
});

describe("a post that leaves the board", () => {
  async function sent(id = "post", at = NOW) {
    await post(id, { score: 9, age: OLD_ENOUGH });
    await tend(at);
    calls.length = 0;
  }

  it("is deleted from the channel, by its author or a moderator", async () => {
    await sent("mine");
    await sent("taken", NOW + 6 * HOUR);
    await fields("mine", `deleted_at = ?2`, NOW);
    await fields("taken", `removed_batch_id = 'batch'`);
    await tend(NOW + 7 * HOUR);
    expect(calls.map((call) => call.method)).toEqual(["deleteMessage", "deleteMessage"]);
    expect(calls[0]!.body).toEqual({ chat_id: "-1001234567890", message_id: 101 });
    expect(await row("mine")).toMatchObject({ retracted_at: NOW + 7 * HOUR });
    expect(await row("taken")).toMatchObject({ retracted_at: NOW + 7 * HOUR });
  });

  it("is written over past the 48 hours a bot can delete it, its media and button gone", async () => {
    await sent();
    await fields("post", `deleted_at = ?2`, NOW);
    answer = (call) => (call.method === "deleteMessage" ? { ok: false, error_code: 400, description: "Bad Request: message can't be deleted" } : { ok: true, result: true });
    await tend(NOW + HOUR);
    expect(calls.map((call) => call.method)).toEqual(["deleteMessage", "editMessageText"]);
    expect(calls[1]!.body).toMatchObject({
      message_id: 101,
      rich_message: { html: "<p>This post was removed from aion.ly.</p>" },
      reply_markup: { inline_keyboard: [] },
    });
    expect(await row("post")).toMatchObject({ retracted_at: NOW + HOUR });
  });

  it("counts as gone when someone deleted it in Telegram already", async () => {
    await sent();
    await fields("post", `deleted_at = ?2`, NOW);
    answer = () => ({ ok: false, error_code: 400, description: "Bad Request: message to delete not found" });
    await tend(NOW + HOUR);
    expect(calls).toHaveLength(1);
    expect(await row("post")).toMatchObject({ retracted_at: NOW + HOUR });
  });

  it("is tried again next run if neither works, and left alone once done", async () => {
    await sent();
    await fields("post", `deleted_at = ?2`, NOW);
    answer = () => ({ ok: false, error_code: 500, description: "Internal Server Error" });
    await tend(NOW + HOUR);
    expect(await row("post")).toMatchObject({ retracted_at: null });
    answer = () => ({ ok: true, result: true });
    await tend(NOW + 2 * HOUR);
    expect(await row("post")).toMatchObject({ retracted_at: NOW + 2 * HOUR });
    calls.length = 0;
    await tend(NOW + 3 * HOUR);
    expect(calls).toHaveLength(0);
  });

  it("leaves a live post's channel post alone", async () => {
    await sent();
    await tend(NOW + HOUR);
    expect(calls).toHaveLength(0);
  });
});
