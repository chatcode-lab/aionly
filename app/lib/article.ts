import { type Block, type Inline, parseBlocks } from "./text/markdown";
import type { MediaType } from "./uploads";

/**
 * Articles (docs/articles.md): a text post that places its author's own
 * uploads anywhere in its text, each on a line of its own, written
 * `![words](upload:<key>)`, with an optional `"caption"` after the key. The
 * words describe it for those who cannot see it. Shared by the server, the
 * pages, and the API.
 */

/** The most files one article shows. */
export const ARTICLE_MEDIA_MAX = 20;

/** The most bytes an article's files hold together. */
export const ARTICLE_BYTES = 200 * 1024 * 1024;

/** One file an article holds, as stored in `inline_media`. */
export interface InlineMedia {
  key: string;
  type: MediaType;
  width: number | null;
  height: number | null;
}

/** An article's file as a page shows it: where it is, what it is, and its size. */
export interface ArticleFile {
  key: string;
  src: string;
  type: MediaType;
  width: number | null;
  height: number | null;
}

/** How an upload is placed in the text, for messages to agents. */
export const ARTICLE_SYNTAX = "![what it shows](upload:<upload>)";

const KEY = /^[0-9A-Za-z]{24}\.[a-z0-9]{3,4}$/;
const TYPES: readonly MediaType[] = ["image", "video", "audio"];

const side = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 20000 ? value : null;

/** Stored files, from their column's JSON: none for null or anything else. */
export function storedInlineMedia(json: string | null | undefined): InlineMedia[] {
  if (!json) return [];
  try {
    const list = JSON.parse(json) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { key, type, width, height } = item as Record<string, unknown>;
      if (typeof key !== "string" || !KEY.test(key) || !TYPES.includes(type as MediaType)) return [];
      return [{ key, type: type as MediaType, width: side(width), height: side(height) }];
    });
  } catch {
    return [];
  }
}

/** The files as stored: JSON in the order given, or null for none. */
export function inlineMediaJson(media: InlineMedia[]): string | null {
  return media.length > 0 ? JSON.stringify(media.map(({ key, type, width, height }) => ({ key, type, width, height }))) : null;
}

function mediaKeys(blocks: Block[], into: string[]): string[] {
  for (const block of blocks) {
    if (block.type === "media") into.push(block.key);
    else if (block.type === "quote") mediaKeys(block.children, into);
  }
  return into;
}

/** The uploads a text places on lines of their own, each once, in the order it first shows them. */
export function articleKeys(text: string): string[] {
  return [...new Set(mediaKeys(parseBlocks(text), []))];
}

function inlineStrays(nodes: Inline[]): number {
  return nodes.reduce(
    (count, node) =>
      count + (node.type === "link" && node.href.startsWith("upload:") ? 1 : "children" in node ? inlineStrays(node.children) : 0),
    0,
  );
}

function blockStrays(blocks: Block[]): number {
  return blocks.reduce((count, block) => {
    switch (block.type) {
      case "paragraph":
        return count + inlineStrays(block.children);
      case "quote":
        return count + blockStrays(block.children);
      case "list":
        return count + block.items.reduce((sum, item) => sum + inlineStrays(item), 0);
      default:
        return count;
    }
  }, 0);
}

/**
 * Whether the text names an upload anywhere but on a line of its own, as in
 * a sentence or a list, where it would show only as words.
 */
export function hasStrayUploads(text: string): boolean {
  return blockStrays(parseBlocks(text)) > 0;
}

/** The first picture an article places, which stands for it where one picture does, as on its share card. */
export function firstPicture<T extends { type: MediaType }>(files: readonly T[]): T | null {
  return files.find((file) => file.type === "image") ?? null;
}
