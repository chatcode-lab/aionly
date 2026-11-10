import { describe, expect, it } from "vitest";

import { parseBlocks } from "../text/markdown";
import { type ChannelMedia, type ChannelPost, channelMessages, PREVIEW_MAX, UPLOAD_FIELD } from "./compose";

const ORIGIN = "https://aion.ly";

function post(fields: Partial<ChannelPost> & { text?: string } = {}): ChannelPost {
  const { text = "First words.", ...rest } = fields;
  return {
    title: "A title",
    path: "/p/abc/a-title",
    blocks: parseBlocks(text),
    names: {},
    outsideLinks: true,
    source: "example.com",
    sourceUrl: "https://example.com/page",
    score: 1,
    comments: 0,
    author: "aisha",
    agent: true,
    media: { type: "none" },
    ...rest,
  };
}

const compose = (fields?: Parameters<typeof post>[0]) => channelMessages(post(fields), ORIGIN);
const richHtml = (message: { params: Record<string, unknown> }) => (message.params.rich_message as { html: string }).html;
const picture = { src: "https://media.aion.ly/a.jpg", animated: false };
const link: ChannelMedia = { type: "link", url: "https://www.youtube.com/watch?v=abc" };

describe("a channel post of what the board hosts", () => {
  it("is one rich message of its media, title, words, source line, and button", () => {
    const [message] = compose({ media: { type: "pictures", pictures: [picture] } });
    expect(message!.method).toBe("sendRichMessage");
    expect(richHtml(message!)).toBe(
      `<img src="https://media.aion.ly/a.jpg"/><h3>A title</h3><p>First words.</p>` +
        `<footer><a href="https://example.com/page">example.com</a> · by 🤖 <a href="https://aion.ly/@aisha">aisha</a></footer>`,
    );
    expect(message!.params.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Read more", url: "https://aion.ly/p/abc/a-title", style: "primary" }]],
    });
    expect(message!.params.disable_notification).toBe(true);
  });

  it("tells Telegram to find nothing in its words, so a name there links to nobody", () => {
    const [message] = compose({ text: "Ask @blocks about it." });
    expect((message!.params.rich_message as { skip_entity_detection: boolean }).skip_entity_detection).toBe(true);
    expect(richHtml(message!)).toContain("Ask @blocks about it.");
  });

  it("keeps a blank line between paragraphs, which Telegram does not draw itself", () => {
    const [message] = compose({ text: "One.\n\nTwo.\n\nThree." });
    expect(richHtml(message!)).toContain("<p>One.<br><br>Two.<br><br>Three.</p>");
  });

  it("shows a gallery as a slideshow in one message", () => {
    const messages = compose({ media: { type: "pictures", pictures: [picture, { ...picture, src: "https://media.aion.ly/b.jpg" }] } });
    expect(richHtml(messages[0]!)).toContain(`<tg-slideshow><img src="https://media.aion.ly/a.jpg"/><img src="https://media.aion.ly/b.jpg"/></tg-slideshow><h3>`);
  });

  it("captions a picture, and plays a GIF as a video", () => {
    const [captioned] = compose({ media: { type: "pictures", pictures: [picture], caption: "A <plate>" } });
    expect(richHtml(captioned!)).toContain(`<figure><img src="https://media.aion.ly/a.jpg"/><figcaption>A &#60;plate&#62;</figcaption></figure>`);
    const [animated] = compose({ media: { type: "pictures", pictures: [{ src: "https://media.aion.ly/a.gif", animated: true }] } });
    expect(richHtml(animated!)).toContain(`<video src="https://media.aion.ly/a.gif"></video>`);
  });

  it("falls back on a video's poster, then on its words, as Telegram refuses a whole message over its media", () => {
    const messages = compose({ media: { type: "video", src: "https://media.aion.ly/v.mp4", poster: "https://media.aion.ly/p.jpg", width: 640, height: 360, duration: 9 } });
    expect(messages).toHaveLength(3);
    expect(richHtml(messages[0]!)).toContain(`<video src="tg://video?id=clip"></video>`);
    expect((messages[0]!.params.rich_message as { media: unknown }).media).toEqual([
      {
        id: "clip",
        media: {
          type: "video",
          media: "https://media.aion.ly/v.mp4",
          cover: "https://media.aion.ly/p.jpg",
          width: 640,
          height: 360,
          duration: 9,
          supports_streaming: true,
        },
      },
    ]);
    expect(richHtml(messages[1]!)).toContain(`<img src="https://media.aion.ly/p.jpg"/>`);
    expect(richHtml(messages[2]!)).toMatch(/^<h3>/);
  });

  it("sends a video too large to fetch with the message", () => {
    const [message] = compose({ media: { type: "video", src: "https://media.aion.ly/v.mp4", upload: "v.mp4", width: 1280, height: 720 } });
    expect(message!.upload).toBe("v.mp4");
    const [attached] = (message!.params.rich_message as { media: { media: { media: string } }[] }).media;
    expect(attached!.media.media).toBe(`attach://${UPLOAD_FIELD}`);
  });

  it("shows a post with no media as its words, with nothing to fall back to", () => {
    expect(compose()).toHaveLength(1);
    expect(richHtml(compose()[0]!)).toMatch(/^<h3>/);
  });
});

describe("a channel post of a link", () => {
  it("is a plain message with Telegram's preview below its words, in case that fails its words alone", () => {
    const messages = compose({ media: link, text: "One.\n\nTwo." });
    expect(messages).toHaveLength(2);
    const { method, params } = messages[0]!;
    expect(method).toBe("sendMessage");
    expect(params.parse_mode).toBe("HTML");
    expect(params.link_preview_options).toEqual({ url: "https://www.youtube.com/watch?v=abc", prefer_large_media: true });
    expect(params.text).toBe(
      `<b>A title</b>\n\nOne.\n\nTwo.\n\n<i><a href="https://example.com/page">example.com</a> · by 🤖 <a href="https://aion.ly/@aisha">aisha</a></i>`,
    );
    expect(params.reply_markup).toEqual(messages[1]!.params.reply_markup);
    expect(messages[1]!.method).toBe("sendRichMessage");
  });

  it("keeps a typed name from linking to a stranger on Telegram, which it cannot be told not to find", () => {
    const [message] = compose({ media: link, text: "Ask @blocks, or me@example.com." });
    expect(message!.params.text).toContain("Ask @⁠blocks");
    expect(message!.params.text).not.toContain("me@⁠example");
  });

  it("writes lists, quotes, and code, which a plain message has no tags for or keeps", () => {
    const [message] = compose({ media: link, text: "- one\n- two\n\n> said\n\n1. first\n2. second\n\n```\nx < 1\n```" });
    expect(message!.params.text).toContain("• one\n• two");
    expect(message!.params.text).toContain("<blockquote>said</blockquote>");
    expect(message!.params.text).toContain("1. first\n2. second");
    expect(message!.params.text).toContain("<pre>x &#60; 1</pre>");
  });

  it("leaves out empty words and a source it does not have", () => {
    const [message] = compose({ media: link, text: "", source: null, sourceUrl: null, agent: false, author: "boris" });
    expect(message!.params.text).toBe(`<b>A title</b>\n\n<i>by 👤 <a href="https://aion.ly/@boris">boris</a></i>`);
  });
});

describe("a channel post's links", () => {
  it("follows the site's rules: a fan's bare address is a link, anyone else's is copied on a tap", () => {
    const fan = richHtml(compose({ text: "See https://example.org/x" })[0]!);
    expect(fan).toContain(`<a href="https://example.org/x">example.org/x</a>`);
    const other = richHtml(compose({ outsideLinks: false, text: "See https://example.org/x" })[0]!);
    expect(other).toContain("<code>example.org/x</code>");
    expect(other).not.toContain("<a href=\"https://example.org");
  });

  it("shows a label of other words as its words alone, and a label of its own address as a fan's link", () => {
    expect(richHtml(compose({ text: "[the source](https://example.org/x)" })[0]!)).toContain("<p>the source</p>");
    expect(richHtml(compose({ text: "[example.org](https://example.org)" })[0]!)).toContain(`<a href="https://example.org">example.org</a>`);
    expect(richHtml(compose({ outsideLinks: false, text: "[example.org](https://example.org)" })[0]!)).toContain("<p>example.org</p>");
  });

  it("writes a fan's email address as a mail link, as a rich message finds none itself", () => {
    const words = "Write to hello@example.org or [hello@example.org](mailto:hello@example.org).";
    const mail = `<a href="mailto:hello@example.org">hello@example.org</a>`;
    expect(richHtml(compose({ text: words })[0]!)).toContain(`Write to ${mail} or ${mail}.`);
    const other = richHtml(compose({ outsideLinks: false, text: words })[0]!);
    expect(other).toContain("Write to <code>hello@example.org</code> or <code>hello@example.org</code>.");
    expect(other).not.toContain("mailto:");
    expect(richHtml(compose({ text: "[write to us](mailto:hello@example.org)" })[0]!)).toContain("<p>write to us</p>");
  });

  it("links a label that is its own address once, never a link within a link", () => {
    expect(richHtml(compose({ text: "[https://example.org/x](https://example.org/x)" })[0]!)).toContain(`<p><a href="https://example.org/x">example.org/x</a></p>`);
    expect(richHtml(compose({ text: "[https://aion.ly/p/xyz](https://aion.ly/p/xyz)" })[0]!)).toContain(`<p><a href="https://aion.ly/p/xyz">aion.ly/p/xyz</a></p>`);
  });

  it("follows a link to the board, at the board's own address", () => {
    const html = richHtml(compose({ text: "[this post](https://aion.ly/p/xyz)" })[0]!);
    expect(html).toContain(`<a href="https://aion.ly/p/xyz">this post</a>`);
  });

  it("writes a mention as a link to the account on the board", () => {
    const html = richHtml(compose({ text: "Thanks <@u1>", names: { u1: { username: "boris", agent: false, deleted: false } } })[0]!);
    expect(html).toContain(`Thanks <a href="https://aion.ly/@boris">@boris</a>`);
  });
});

describe("a channel post's words", () => {
  const long = "word ".repeat(40).trim();

  it("takes whole paragraphs while they fit", () => {
    const html = richHtml(compose({ text: [long, long, long].join("\n\n") })[0]!);
    expect(html.match(/word/g)).toHaveLength(80);
  });

  it("cuts a first paragraph past the most at a word, its formatting kept", () => {
    const html = richHtml(compose({ text: `**${"word ".repeat(200).trim()}**` })[0]!);
    const words = html.match(/<p><b>(word(?: word)+…)<\/b><\/p>/)?.[1];
    expect(words).toBeDefined();
    expect(words!.length).toBeLessThanOrEqual(PREVIEW_MAX);
  });

  it("makes a bold line a heading, and never stops on one", () => {
    const html = richHtml(compose({ text: `**Lead**\n\nOpening.\n\n**Next part**\n\n${"word ".repeat(120).trim()}` })[0]!);
    expect(html).toContain("<h4>Lead</h4><p>Opening.</p>");
    expect(html).not.toContain("Next part");
  });

  it("cuts a long list by its items", () => {
    const html = richHtml(compose({ text: Array.from({ length: 30 }, () => `- ${"word ".repeat(10).trim()}`).join("\n") })[0]!);
    expect(html.match(/<li>/g)!.length).toBeLessThan(11);
  });

  it("escapes the post's own words", () => {
    const [message] = compose({ title: `A <b> & "c"`, text: "x < y" });
    expect(richHtml(message!)).toContain("<h3>A &#60;b&#62; &#38; &#34;c&#34;</h3><p>x &#60; y</p>");
  });
});

describe("a channel post's source line", () => {
  it("names points and comments only past the digest's thresholds", () => {
    expect(richHtml(compose({ score: 9, comments: 4 })[0]!)).not.toMatch(/points?|comments?/);
    const html = richHtml(compose({ score: 10, comments: 5 })[0]!);
    expect(html).toContain("· 10 points · 5 comments · by");
  });

  it("names what a post is when it leads nowhere", () => {
    expect(richHtml(compose({ source: "Gallery", sourceUrl: null })[0]!)).toContain("<footer>Gallery · by");
  });
});
