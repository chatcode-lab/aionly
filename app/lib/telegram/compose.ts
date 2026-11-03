/**
 * A board post as a post on its Telegram channel (owner's request,
 * 2026-11-03): its media, title, opening words, the digest's line of where
 * it leads and who wrote it, and a button to the post. Pure, so it is
 * unit-tested; ./channel.server.ts chooses the post and sends it.
 *
 * Telegram has two kinds of message, and each post takes the one that can
 * show it. What the board hosts is a rich message: one message holding the
 * media, a heading, and a button, which an album of pictures cannot hold.
 * A link is a plain message over Telegram's own preview of it, below the
 * words, as the preview's size and text are Telegram's and only a plain
 * message has one; a player in it plays in the app.
 */

import { COUNTED } from "../digest/compose";
import { labelIsAddress } from "../links/label";
import { sitePath } from "../links/site-path";
import { escape } from "../mail/layout";
import { clip } from "../meta";
import { type Block, type Inline, mailtoAddress } from "../text/markdown";
import type { MentionNames } from "../text/mentions";

/** The most of a post's opening a channel post shows, in whole paragraphs where it can. */
export const PREVIEW_MAX = 500;

/** The part of a sent form a stored file travels in. */
export const UPLOAD_FIELD = "clipfile";

/** One picture of a post; a GIF is sent as a video is, and Telegram plays it. */
export interface ChannelPicture {
  src: string;
  animated: boolean;
}

/** What a channel post shows with its words. */
export type ChannelMedia =
  | { type: "none" }
  /** An outside link, in Telegram's own preview. */
  | { type: "link"; url: string }
  | { type: "pictures"; pictures: ChannelPicture[]; caption?: string | null }
  | {
      type: "video";
      src: string;
      /** The stored file's key, when it is too large for Telegram to fetch and is sent with the message. */
      upload?: string;
      /** A picture to fall back on, and to show until the video plays. */
      poster?: string;
      width?: number;
      height?: number;
      duration?: number;
    }
  | { type: "audio"; src: string };

export interface ChannelPost {
  title: string;
  /** The post's own path on the board. */
  path: string;
  /** Its description, parsed. */
  blocks: Block[];
  /** The names of the accounts its text mentions. */
  names: MentionNames;
  /** Its author's outside addresses are real links, as on the site. */
  outsideLinks: boolean;
  /** Where it leads, as the digest names it, and the address, if it has one. */
  source: string | null;
  sourceUrl: string | null;
  score: number;
  comments: number;
  author: string;
  /** The author is an agent, marked as one before their name; a person otherwise. */
  agent: boolean;
  media: ChannelMedia;
}

export interface ChannelMessage {
  method: "sendRichMessage" | "sendMessage";
  params: Record<string, unknown>;
  /** The key of a stored file to send with it, in `UPLOAD_FIELD`. */
  upload?: string;
}

/** What a channel post older than Telegram lets a bot delete becomes once it leaves the board. */
export const RETRACTED = {
  rich_message: { html: "<p>This post was removed from aion.ly.</p>", skip_entity_detection: true },
  reply_markup: { inline_keyboard: [] },
};

interface Writing {
  origin: string;
  outsideLinks: boolean;
  names: MentionNames;
  /** Telegram finds names and addresses in a plain message's text, and cannot be told not to. */
  plain: boolean;
}

const link = (href: string, words: string) => `<a href="${escape(href)}">${words}</a>`;

/**
 * Text as Telegram should read it. In a plain message a word joiner keeps an
 * `@name` from linking to whoever holds that name on Telegram, a stranger
 * more often than not; a rich message is told to find nothing.
 */
const text = (words: string, writing: Writing) => {
  const safe = escape(words);
  return writing.plain ? safe.replace(/(^|[^\p{L}\p{N}_@/.:-])@(?=[A-Za-z0-9_])/gu, "$1@⁠") : safe;
};

/** A node's words, without their formatting. */
const wordsOf = (nodes: Inline[]): string =>
  nodes
    .map((node) => {
      if ("children" in node) return wordsOf(node.children);
      if (node.type === "url") return node.href;
      if (node.type === "email") return node.address;
      return node.type === "text" || node.type === "code" ? node.text : "";
    })
    .join("");

/**
 * Inline Markdown as Telegram's HTML, by the site's rules for links: one to
 * the board is followed; an outside address is a real link only in a fan's
 * text, and elsewhere is code, which a tap copies, as the site's does; a
 * label of other words is its words alone.
 */
function inline(nodes: Inline[], writing: Writing): string {
  const site = (href: string) => {
    const path = sitePath(href, new URL(writing.origin).host);
    return path === null ? null : `${writing.origin}${path}`;
  };
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return text(node.text, writing);
        case "break":
          return writing.plain ? "\n" : "<br>";
        case "code":
          return `<code>${escape(node.text)}</code>`;
        case "strong":
          return `<b>${inline(node.children, writing)}</b>`;
        case "em":
          return `<i>${inline(node.children, writing)}</i>`;
        case "strike":
          return `<s>${inline(node.children, writing)}</s>`;
        case "mention": {
          const name = writing.names[node.id];
          return name ? link(`${writing.origin}/@${name.username}`, `@${escape(name.username)}`) : "";
        }
        case "email":
          return writing.outsideLinks ? escape(node.address) : `<code>${escape(node.address)}</code>`;
        case "url": {
          const own = site(node.href);
          const shown = escape(node.href.replace(/^https?:\/\//, ""));
          if (own) return link(own, shown);
          return writing.outsideLinks ? link(node.href, shown) : `<code>${shown}</code>`;
        }
        case "link": {
          const words = inline(node.children, writing);
          const own = site(node.href);
          if (own) return link(own, words);
          const label = wordsOf(node.children);
          const address = mailtoAddress(node.href);
          if (writing.outsideLinks && !address && labelIsAddress(label, node.href)) return link(node.href, words);
          return words;
        }
      }
    })
    .join("");
}

/** A short paragraph of nothing but bold words is how the board's articles write a heading. */
const headingLike = (block: Block) =>
  block.type === "paragraph" && block.children.length === 1 && block.children[0]!.type === "strong" && wordsOf(block.children).length <= 120;

function sizeOf(block: Block): number {
  switch (block.type) {
    case "paragraph":
      return wordsOf(block.children).length;
    case "code":
      return block.text.length;
    case "quote":
      return block.children.reduce((total, child) => total + sizeOf(child), 0);
    case "list":
      return block.items.reduce((total, item) => total + wordsOf(item).length, 0);
    default:
      return 0;
  }
}

/** Nodes cut to `room` characters at a word, their formatting kept, ending in an ellipsis. */
function cutNodes(nodes: Inline[], room: number): Inline[] {
  const kept: Inline[] = [];
  let left = room;
  for (const node of nodes) {
    const size = wordsOf([node]).length;
    if (size <= left) {
      kept.push(node);
      left -= size;
      continue;
    }
    if ("children" in node) kept.push({ ...node, children: cutNodes(node.children, left) });
    // Too little room for a word is only the ellipsis.
    else kept.push({ type: "text", text: node.type === "text" && left >= 20 ? clip(node.text, left) : "…" });
    return kept;
  }
  return kept;
}

function cutBlock(block: Block, room: number): Block {
  switch (block.type) {
    case "paragraph":
      return { ...block, children: cutNodes(block.children, room) };
    case "code":
      return { ...block, text: `${block.text.slice(0, room).trimEnd()}…` };
    case "quote":
      return { ...block, children: lead(block.children, room) };
    case "list": {
      const items: Inline[][] = [];
      let left = room;
      for (const item of block.items) {
        const size = wordsOf(item).length;
        if (items.length > 0 && size > left) break;
        items.push(size > left ? cutNodes(item, left) : item);
        left -= size;
      }
      return { ...block, items };
    }
    default:
      return block;
  }
}

/**
 * A post's first blocks, to `room` characters: whole ones while they fit,
 * and the first of any words cut to fit, never stopping on a heading with
 * nothing under it. What it places in its text is left out, as a card
 * leaves it.
 */
function lead(blocks: Block[], room: number): Block[] {
  const kept: Block[] = [];
  let left = room;
  for (const block of blocks) {
    if (block.type === "media" || block.type === "embed") continue;
    const size = sizeOf(block);
    if (size > left) {
      if (kept.every(headingLike)) kept.push(cutBlock(block, left));
      break;
    }
    kept.push(block);
    left -= size;
  }
  while (kept.length > 1 && headingLike(kept.at(-1)!)) kept.pop();
  return kept;
}

/** A block's words in a quotation, which holds lines rather than blocks. */
function quoted(block: Block, writing: Writing): string[] {
  switch (block.type) {
    case "paragraph":
      return [inline(block.children, writing)];
    case "code":
      return [escape(block.text)];
    case "quote":
      return block.children.flatMap((child) => quoted(child, writing));
    case "list":
      return block.items.map((item) => inline(item, writing));
    default:
      return [];
  }
}

const quotation = (block: Block, writing: Writing) =>
  `<blockquote>${quoted(block, writing).join(writing.plain ? "\n" : "<br>")}</blockquote>`;

/**
 * Blocks as a rich message's HTML. Telegram draws its paragraphs with no gap
 * between them, so neighbours share one, a blank line apart (owner's
 * request, 2026-11-02).
 */
function richBody(blocks: Block[], writing: Writing): string {
  const parts: string[] = [];
  let paragraphs: string[] = [];
  const close = () => {
    if (paragraphs.length > 0) parts.push(`<p>${paragraphs.join("<br><br>")}</p>`);
    paragraphs = [];
  };
  for (const block of blocks) {
    if (block.type === "paragraph" && !headingLike(block)) {
      paragraphs.push(inline(block.children, writing));
      continue;
    }
    close();
    if (block.type === "paragraph") parts.push(`<h4>${inline((block.children[0] as { children: Inline[] }).children, writing)}</h4>`);
    if (block.type === "code") parts.push(`<pre>${escape(block.text)}</pre>`);
    if (block.type === "quote") parts.push(quotation(block, writing));
    if (block.type === "list") {
      const items = block.items.map((item) => `<li>${inline(item, writing)}</li>`).join("");
      parts.push(block.ordered ? `<ol start="${block.start}">${items}</ol>` : `<ul>${items}</ul>`);
    }
  }
  close();
  return parts.join("");
}

/** Blocks as a plain message's HTML, which has no paragraphs, headings, or lists to tag. */
function plainBody(blocks: Block[], writing: Writing): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "paragraph":
          return inline(block.children, writing);
        case "code":
          return `<pre>${escape(block.text)}</pre>`;
        case "quote":
          return quotation(block, writing);
        case "list":
          return block.items.map((item, index) => `${block.ordered ? `${block.start + index}.` : "•"} ${inline(item, writing)}`).join("\n");
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

/** The line under the words, the digest's: where it leads, what counts, and who wrote it. */
function sourceLine(post: ChannelPost, origin: string): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const source = post.source && (post.sourceUrl ? link(post.sourceUrl, escape(post.source)) : escape(post.source));
  return [
    ...(source ? [source] : []),
    ...(post.score >= COUNTED.points ? [plural(post.score, "point")] : []),
    ...(post.comments >= COUNTED.comments ? [plural(post.comments, "comment")] : []),
    // With no "@", which Telegram would take for one of its own names.
    `by ${post.agent ? "🤖" : "👤"} ${link(`${origin}/@${post.author}`, escape(post.author))}`,
  ].join(" · ");
}

const pictureTag = (picture: ChannelPicture) =>
  picture.animated ? `<video src="${escape(picture.src)}"></video>` : `<img src="${escape(picture.src)}"/>`;

/** Pictures above a rich message's words: a gallery as a slideshow, swiped as the site's is. */
function picturesHtml(media: Extract<ChannelMedia, { type: "pictures" }>): string {
  const [first] = media.pictures;
  if (media.pictures.length > 1) return `<tg-slideshow>${media.pictures.map(pictureTag).join("")}</tg-slideshow>`;
  if (!first) return "";
  return media.caption ? `<figure>${pictureTag(first)}<figcaption>${escape(media.caption)}</figcaption></figure>` : pictureTag(first);
}

export function channelMessages(post: ChannelPost, origin: string): ChannelMessage[] {
  const writing = (plain: boolean): Writing => ({ origin, outsideLinks: post.outsideLinks, names: post.names, plain });
  const blocks = lead(post.blocks, PREVIEW_MAX);
  const reply_markup = { inline_keyboard: [[{ text: "Read more", url: `${origin}${post.path}`, style: "primary" }]] };
  const line = sourceLine(post, origin);

  const rich = (media = "", attachments?: unknown[], upload?: string): ChannelMessage => ({
    method: "sendRichMessage",
    params: {
      rich_message: {
        html: `${media}<h3>${escape(post.title)}</h3>${richBody(blocks, writing(false))}<footer>${line}</footer>`,
        skip_entity_detection: true,
        ...(attachments ? { media: attachments } : {}),
      },
      reply_markup,
      disable_notification: true,
    },
    ...(upload ? { upload } : {}),
  });
  // Telegram refuses a whole message over its media, so each post ends in its words alone.
  const words = rich();

  const { media } = post;
  switch (media.type) {
    case "none":
      return [words];
    case "link":
      return [
        {
          method: "sendMessage",
          params: {
            text: [`<b>${escape(post.title)}</b>`, plainBody(blocks, writing(true)), `<i>${line}</i>`].filter(Boolean).join("\n\n"),
            parse_mode: "HTML",
            // Telegram puts it below the words unless told otherwise.
            link_preview_options: { url: media.url, prefer_large_media: true },
            reply_markup,
            disable_notification: true,
          },
        },
        words,
      ];
    case "pictures":
      return [rich(picturesHtml(media)), words];
    case "audio":
      return [rich(`<audio src="${escape(media.src)}"></audio>`), words];
    case "video": {
      const { src, upload, poster, width, height, duration } = media;
      const clipped = {
        type: "video",
        media: upload ? `attach://${UPLOAD_FIELD}` : src,
        ...(poster ? { cover: poster } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(duration ? { duration } : {}),
        supports_streaming: true,
      };
      const video = rich(`<video src="tg://video?id=clip"></video>`, [{ id: "clip", media: clipped }], upload);
      return [video, ...(poster ? [rich(pictureTag({ src: poster, animated: false }))] : []), words];
    }
  }
}
