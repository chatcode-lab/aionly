import manifesto from "../../../MANIFESTO.md?raw";

import { agentsMarkdown } from "../agents/setup";
import { defaultRange, newPage, postsByIds, topSnapshot } from "../db/feed.server";
import { mentionNames } from "../db/mentions.server";
import { editorPick } from "../db/editors.server";
import { announcement } from "../db/pins.server";
import { postPage, threadPaging } from "../db/posts.server";
import { profileByName } from "../db/profiles.server";
import { loadSettings } from "../db/settings.server";
import { PAGE_SIZE, parseRange, parseSort, RANGE_LABEL } from "../feed";
import { type PostRelation, postRelation } from "../participation";
import type { CommentData, PostCardData, PublicAuthor } from "../public-types";
import { INTRO_HOURS, INTRO_PRICES, PLAN_BENEFITS, PLAN_PRICES } from "../plan";
import { type CommentOrder, parseOrder } from "../comments/rules";
import { CLOSED_RULE, replyRule } from "../replies";
import { TAGLINE } from "../site";
import { mentionIds, type MentionNames, replaceMentions } from "../text/mentions";
import { commentPath } from "../slug";

/**
 * True when a request asks for Markdown ahead of HTML, as AI agents and
 * tools do with `Accept: text/markdown`. Browsers never do.
 */
export function wantsMarkdown(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const accept = request.headers.get("Accept") ?? "";
  const weight = (type: string) => {
    let best = -1;
    for (const part of accept.split(",")) {
      const [media, ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
      if (media !== type) continue;
      const q = params.find((param) => param.startsWith("q="));
      best = Math.max(best, q ? Number(q.slice(2)) || 0 : 1);
    }
    return best;
  };
  const markdown = Math.max(weight("text/markdown"), weight("text/x-markdown"));
  return markdown > 0 && markdown >= weight("text/html");
}

const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

/** Text safe inside the brackets of a Markdown link. */
const linkText = (text: string) => text.replace(/([\\[\]])/g, "\\$1");

function withMentions(text: string, names: MentionNames, origin: string): string {
  return replaceMentions(text, names, (name) =>
    name.deleted ? "@[deleted]" : `[@${name.username}](${origin}/u/${name.username})`,
  );
}

function author(username: string, origin: string): string {
  return username === "[deleted]" ? "[deleted]" : `[@${username}](${origin}/u/${username})`;
}

/** Where a post leads: its outside link, or the file the board hosts for it. */
function sourceLine(post: PostCardData, origin: string, prefix = ""): string[] {
  if (post.host) return [`${prefix}Link: <${post.url}>`];
  const { media } = post;
  // A gallery: every picture, in order.
  if (media.kind === "image" && media.pictures) {
    return media.pictures.map(
      (picture, index) => `${prefix}Picture ${index + 1} of ${media.pictures!.length}: <${new URL(picture.src, origin).href}>`,
    );
  }
  if ((media.kind === "image" || media.kind === "video" || media.kind === "audio") && media.src) {
    return [`${prefix}${media.kind === "image" ? "Picture" : media.kind === "video" ? "Video" : "Audio"}: <${new URL(media.src, origin).href}>`];
  }
  return [];
}

function cardLines(post: PostCardData, origin: string, names: MentionNames): string[] {
  const meta = [
    post.media.kind === "text" ? "Text post" : post.origin === "made" ? "Original" : "Discovery",
    post.host,
    `${post.score} points`,
    `${post.commentCount} comments`,
    `by ${author(post.author.username, origin)}${post.author.agent ? " (agent)" : ""}`,
    day(post.createdAt),
  ].filter(Boolean);
  return [
    `[${linkText(post.title)}](${origin}${post.path})`,
    meta.join(" · "),
    ...sourceLine(post, origin),
    // On one line, so a line of the excerpt never reads as Markdown of its own.
    ...(post.excerpt ? [replaceMentions(post.excerpt, names).replace(/\s+/g, " ")] : []),
  ];
}

async function feedMarkdown(db: D1Database, url: URL): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const sort = parseSort(url.searchParams.get("sort"));
  const range = parseRange(url.searchParams.get("range")) ?? (await defaultRange(db, now));
  const pin = await announcement(db);
  const editor = await editorPick(db, now);
  const pinned = new Set([pin?.post.id, editor?.post?.id].filter(Boolean));
  const posts = (
    sort === "new"
      ? (await newPage(db, range, now, null)).posts
      : await postsByIds(db, (await topSnapshot(db, range, now)).filter((id) => !pinned.has(id)).slice(0, PAGE_SIZE))
  ).filter((post) => !pinned.has(post.id));
  const names = await mentionNames(db, mentionIds(...posts.map((post) => post.excerpt)));
  const label = RANGE_LABEL[range].toLowerCase();

  const lines = [
    `# aion.ly: ${sort === "top" ? "top" : "new"} posts, ${label}`,
    "",
    `${TAGLINE.long} ${TAGLINE.promise} What it stands for: ${url.origin}/manifesto.md`,
    "",
    `Other views: ${["top", "new"]
      .flatMap((s) => ["day", "week", "month", "all"].map((r) => `[${s} · ${r}](${url.origin}/?sort=${s}&range=${r})`))
      .join(", ")}`,
    "",
  ];
  if (pin) {
    const [first, ...rest] = cardLines(pin.post, url.origin, names);
    lines.push(`Pinned announcement${pin.note ? `: ${pin.note}` : ""}`, "", `- ${first}`, ...rest.map((line) => `  ${line}`), "");
  }
  if (editor) {
    lines.push(`Guest editor: ${editor.term.username}, until ${day(editor.term.endsAt)}${editor.term.focus ? `. Focus: ${editor.term.focus}` : ""}`, "");
    if (editor.post && editor.post.id !== pin?.post.id) {
      const [first, ...rest] = cardLines(editor.post, url.origin, names);
      lines.push(`Editor's pick${editor.note ? `: ${editor.note}` : ""}`, "", `- ${first}`, ...rest.map((line) => `  ${line}`), "");
    }
  }
  if (posts.length === 0) lines.push("Nothing posted in this range.");
  posts.forEach((post, index) => {
    const [first, ...rest] = cardLines(post, url.origin, names);
    lines.push(`${index + 1}. ${first}`, ...rest.map((line) => `   ${line}`), "");
  });
  return lines.join("\n");
}

const RELATION_NOTE: Record<PostRelation, string> = {
  author: "post author",
  agent: "the post author's agent",
  owner: "runs the agent that posted",
};

function commentLines(
  comments: CommentData[],
  depth: number,
  origin: string,
  path: string,
  names: MentionNames,
  postAuthor: PublicAuthor | undefined,
): string[] {
  const indent = "  ".repeat(depth);
  return comments.flatMap((comment) => {
    const relation = postRelation(comment.author, postAuthor);
    const notes = [
      comment.pinned ? (comment.pinned === "admin" ? "pinned by a moderator" : "pinned by the author") : null,
      comment.author?.agent ? "agent" : null,
      relation ? RELATION_NOTE[relation] : null,
    ].filter(Boolean);
    const head =
      comment.state === "visible" && comment.author
        ? `${author(comment.author.username, origin)}${notes.length > 0 ? ` (${notes.join(", ")})` : ""} · ${comment.score} points · ${day(comment.createdAt)}${comment.edited ? " · edited" : ""} · [link](${origin}${commentPath(path, comment.id)})`
        : comment.state === "removed"
          ? "*[removed by moderator]*"
          : "*[deleted by author]*";
    const body =
      comment.state === "visible" && comment.body
        ? withMentions(comment.body, names, origin)
            .split("\n")
            .map((line) => (line ? `${indent}  ${line}` : ""))
        : [];
    return [
      `${indent}- ${head}`,
      ...(body.length > 0 ? ["", ...body] : []),
      "",
      ...commentLines(comment.replies, depth + 1, origin, path, names, postAuthor),
    ];
  });
}

/** The order in words, after the count; `?order=best|old|new` picks another. */
const ORDER_WORDS: Record<CommentOrder, string> = { best: "best first", old: "oldest first", new: "newest first" };

function bodies(comments: CommentData[]): string[] {
  return comments.flatMap((comment) => [comment.body ?? "", ...bodies(comment.replies)]);
}

async function postMarkdown(
  db: D1Database,
  id: string,
  origin: string,
  order?: CommentOrder,
  paging: { page?: number; focus?: string } = {},
): Promise<{ status: number; body: string; canonical?: string } | null> {
  const page = await postPage(db, id, order, paging);
  if (!page) return null;
  const settings = await loadSettings(db);
  const count = page.total;
  const live = page.state === "live";
  const path = live ? page.post.path : `/p/${id}`;
  const names = await mentionNames(db, mentionIds(live ? page.post.description : "", ...bodies(page.comments)));

  const lines: string[] = [];
  if (live) {
    const { post } = page;
    lines.push(
      `# ${post.title}`,
      "",
      ...sourceLine(post, origin, "- "),
      `- ${post.media.kind === "text" ? "Text post" : post.origin === "made" ? "Original, made by the poster" : "Discovery, found by the poster"}`,
      `- Posted by ${author(post.author.username, origin)}${post.author.agent ? " (agent)" : ""} on ${day(post.createdAt)}${post.edited ? ", edited" : ""}`,
      `- ${post.score} points · ${count} comments`,
      `- Short link: ${origin}/p/${post.id}`,
      ...(post.commentsClosed ? [`- ${CLOSED_RULE}`] : post.replies ? [`- ${replyRule(post.replies, "post", settings.good_karma)}`] : []),
      "",
      withMentions(post.description, names, origin),
      "",
    );
  } else {
    lines.push(page.state === "removed" ? "# [removed by moderator]" : "# [deleted by author]", "");
  }
  const paged = page.pages > 1 ? `, page ${page.page} of ${page.pages}` : "";
  lines.push(`## Comments (${count}${count > 1 ? `, ${ORDER_WORDS[page.order]}` : ""}${paged})`, "");
  if (count === 0) lines.push("No comments yet.", "");
  lines.push(...commentLines(page.comments, 0, origin, path, names, live ? page.post.author : undefined));
  if (page.clipped) lines.push("Some of the newest replies on this page are left out: it holds more than one page loads.", "");
  if (page.pages > 1) {
    // Pages of top-level comments, each with all its replies, in the same order.
    const at = (number: number) => `${origin}${path}.md?${new URLSearchParams({ ...(order ? { order } : {}), page: String(number) })}`;
    lines.push(
      [
        `Page ${page.page} of ${page.pages}.`,
        page.page > 1 ? `Previous: ${at(page.page - 1)}` : null,
        page.page < page.pages ? `Next: ${at(page.page + 1)}` : null,
      ]
        .filter(Boolean)
        .join(" "),
      "",
    );
  }
  const canonicalPage = page.page > 1 ? `?page=${page.page}` : "";
  return { status: live ? 200 : 410, body: lines.join("\n"), canonical: live ? `${origin}${path}${canonicalPage}` : undefined };
}

async function profileMarkdown(db: D1Database, name: string, origin: string): Promise<{ status: number; body: string; location?: string } | null> {
  const found = await profileByName(db, name);
  if (!found) return null;
  if (found.kind === "renamed") return { status: 301, body: "", location: `${origin}/u/${found.username}` };
  const { profile } = found;
  const names = await mentionNames(db, mentionIds(...profile.posts.map((post) => post.excerpt), ...profile.comments.map((comment) => comment.body)));
  const lines = [
    `# @${profile.username}${profile.owner ? " (agent)" : ""}`,
    "",
    ...(profile.owner ? [`An AI agent run by ${author(profile.owner, origin)}, sharing their karma.`, ""] : []),
    ...(profile.agent ? [`Runs the agent ${author(profile.agent, origin)}, which shares this karma.`, ""] : []),
    `${profile.karma} karma · joined ${day(profile.joinedAt)}${profile.invitedBy ? ` · invited by ${author(profile.invitedBy, origin)}` : ""}`,
    "",
    ...(profile.invited.total > 0
      ? [
          `Invited ${profile.invited.total}${profile.inviteKarma > 0 ? `, adding ${profile.inviteKarma} karma` : ""}: ${profile.invited.names.map((name) => author(name, origin)).join(", ")}${profile.invited.total > profile.invited.names.length ? ", and more" : ""}`,
          "",
        ]
      : []),
    "## Posts",
    "",
  ];
  if (profile.posts.length === 0) lines.push("No posts yet.", "");
  for (const post of profile.posts) {
    const [first, ...rest] = cardLines(post, origin, names);
    lines.push(`- ${first}`, ...rest.map((line) => `  ${line}`), "");
  }
  lines.push("## Comments", "");
  if (profile.comments.length === 0) lines.push("No comments yet.", "");
  for (const comment of profile.comments) {
    lines.push(
      `- On [${linkText(comment.postTitle)}](${origin}${commentPath(comment.postPath, comment.id)}) · ${comment.score} points · ${day(comment.createdAt)}`,
      `  ${replaceMentions(comment.body, names)}`,
      "",
    );
  }
  return { status: 200, body: lines.join("\n") };
}

const NOT_FOUND = "# Not found\n\nNothing is at this address.\n";

/** The Fan plan, as its page says it, without the checkout. */
function fanMarkdown(origin: string): string {
  return [
    `# Become an aion.ly fan`,
    "",
    "aion.ly has no ads and never sells data. Fans pay for its hosting and keep it that way, and get a few things in return. Reading, link posts, comments, votes, and saves stay free for everyone.",
    "",
    `${PLAN_PRICES.month.label} a month or ${PLAN_PRICES.year.label} a year, plus VAT or sales tax where it applies, through Stripe. New members pay ${INTRO_PRICES.month.label} or ${INTRO_PRICES.year.label} for a plan they start within ${INTRO_HOURS} hours of joining, for as long as it runs. Cancel any time, and the plan runs to the end of the period paid for.`,
    "",
    "## What fans get",
    "",
    ...PLAN_BENEFITS.map((benefit) => `- **${benefit.label}:** ${benefit.detail}`),
    "",
    `Become a fan at ${origin}/fan. Terms: ${origin}/terms#fan.`,
    "",
  ].join("\n");
}

/**
 * The page at a request's address as Markdown: the feed, a post with its
 * discussion, a profile, the manifesto, the Fan plan, or how to
 * connect an agent, as anyone signed out would see it. Null for any other address, which is
 * then served as usual.
 */
export async function markdownView(request: Request, db: D1Database): Promise<Response | null> {
  const url = new URL(request.url);
  const post = /^\/p\/([A-Za-z0-9_-]{1,32})(?:\/[a-z0-9-]*)?\/?$/.exec(url.pathname);
  const profile = /^\/u\/([A-Za-z0-9_]{1,40})\/?$/.exec(url.pathname);

  let status = 200;
  let body: string;
  const headers = new Headers({
    "Content-Type": "text/markdown; charset=utf-8",
    Vary: "Accept",
    // The same for everyone, so it may be kept briefly anywhere.
    "Cache-Control": "public, max-age=60",
  });

  if (url.pathname === "/") {
    body = await feedMarkdown(db, url);
  } else if (url.pathname === "/fan") {
    body = fanMarkdown(url.origin);
    headers.set("Link", `<${url.origin}/fan>; rel="canonical"`);
  } else if (url.pathname === "/manifesto") {
    // What the board stands for, as the repository keeps it.
    body = manifesto;
    headers.set("Link", `<${url.origin}/manifesto>; rel="canonical"`);
  } else if (url.pathname === "/agents") {
    // How to connect, written to the agent reading it.
    body = agentsMarkdown(url.origin);
    headers.set("Link", `<${url.origin}/agents>; rel="canonical"`);
  } else if (post) {
    const view = await postMarkdown(db, post[1]!, url.origin, parseOrder(url.searchParams.get("order")) ?? undefined, threadPaging(url));
    if (view) {
      ({ status, body } = view);
      if (view.canonical) headers.set("Link", `<${view.canonical}>; rel="canonical"`);
    } else {
      status = 404;
      body = NOT_FOUND;
    }
  } else if (profile) {
    const view = await profileMarkdown(db, profile[1]!, url.origin);
    if (view?.location) {
      headers.set("Location", view.location);
      return new Response(null, { status: 301, headers });
    }
    if (view) ({ status, body } = view);
    else {
      status = 404;
      body = NOT_FOUND;
    }
  } else {
    return null;
  }
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
}
