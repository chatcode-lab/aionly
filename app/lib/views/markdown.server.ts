import { defaultRange, newPage, postsByIds, topSnapshot } from "../db/feed.server";
import { mentionNames } from "../db/mentions.server";
import { announcement } from "../db/pins.server";
import { postPage } from "../db/posts.server";
import { profileByName } from "../db/profiles.server";
import { PAGE_SIZE, parseRange, parseSort, RANGE_LABEL } from "../feed";
import type { CommentData, PostCardData } from "../public-types";
import { mentionIds, type MentionNames, replaceMentions } from "../text/mentions";

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

function cardLines(post: PostCardData, origin: string, names: MentionNames): string[] {
  const meta = [
    post.origin === "made" ? "Original" : "Discovery",
    post.host,
    `${post.score} points`,
    `${post.commentCount} comments`,
    `by ${author(post.author.username, origin)}${post.author.agent ? " (agent)" : ""}`,
    day(post.createdAt),
  ].filter(Boolean);
  return [
    `[${linkText(post.title)}](${origin}${post.path})`,
    meta.join(" · "),
    `Link: <${post.url}>`,
    ...(post.excerpt ? [replaceMentions(post.excerpt, names)] : []),
  ];
}

async function feedMarkdown(db: D1Database, url: URL): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const sort = parseSort(url.searchParams.get("sort"));
  const range = parseRange(url.searchParams.get("range")) ?? (await defaultRange(db, now));
  const pin = await announcement(db);
  const posts = (
    sort === "new"
      ? (await newPage(db, range, now, null)).posts
      : await postsByIds(db, (await topSnapshot(db, range, now)).filter((id) => id !== pin?.post.id).slice(0, PAGE_SIZE))
  ).filter((post) => post.id !== pin?.post.id);
  const names = await mentionNames(db, mentionIds(...posts.map((post) => post.excerpt)));
  const label = RANGE_LABEL[range].toLowerCase();

  const lines = [
    `# aion.ly: ${sort === "top" ? "top" : "new"} posts, ${label}`,
    "",
    "A public board for things made with AI, and the AI news worth sharing.",
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
  if (posts.length === 0) lines.push("Nothing posted in this range.");
  posts.forEach((post, index) => {
    const [first, ...rest] = cardLines(post, url.origin, names);
    lines.push(`${index + 1}. ${first}`, ...rest.map((line) => `   ${line}`), "");
  });
  return lines.join("\n");
}

function commentLines(comments: CommentData[], depth: number, origin: string, path: string, names: MentionNames): string[] {
  const indent = "  ".repeat(depth);
  return comments.flatMap((comment) => {
    const head =
      comment.state === "visible" && comment.author
        ? `${author(comment.author.username, origin)}${comment.author.agent ? " (agent)" : ""} · ${comment.score} points · ${day(comment.createdAt)}${comment.edited ? " · edited" : ""} · [link](${origin}${path}#c-${comment.id})`
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
      ...commentLines(comment.replies, depth + 1, origin, path, names),
    ];
  });
}

function bodies(comments: CommentData[]): string[] {
  return comments.flatMap((comment) => [comment.body ?? "", ...bodies(comment.replies)]);
}

async function postMarkdown(db: D1Database, id: string, origin: string): Promise<{ status: number; body: string; canonical?: string } | null> {
  const page = await postPage(db, id);
  if (!page) return null;
  const count = bodies(page.comments).length;
  const live = page.state === "live";
  const path = live ? page.post.path : `/p/${id}`;
  const names = await mentionNames(db, mentionIds(live ? page.post.description : "", ...bodies(page.comments)));

  const lines: string[] = [];
  if (live) {
    const { post } = page;
    lines.push(
      `# ${post.title}`,
      "",
      `- Link: <${post.url}>`,
      `- ${post.origin === "made" ? "Original, made by the poster" : "Discovery, found by the poster"}`,
      `- Posted by ${author(post.author.username, origin)}${post.author.agent ? " (agent)" : ""} on ${day(post.createdAt)}${post.edited ? ", edited" : ""}`,
      `- ${post.score} points · ${count} comments`,
      `- Short link: ${origin}/p/${post.id}`,
      "",
      withMentions(post.description, names, origin),
      "",
    );
  } else {
    lines.push(page.state === "removed" ? "# [removed by moderator]" : "# [deleted by author]", "");
  }
  lines.push(`## Comments (${count})`, "");
  if (count === 0) lines.push("No comments yet.", "");
  lines.push(...commentLines(page.comments, 0, origin, path, names));
  return { status: live ? 200 : 410, body: lines.join("\n"), canonical: live ? `${origin}${path}` : undefined };
}

async function profileMarkdown(db: D1Database, name: string, origin: string): Promise<{ status: number; body: string; location?: string } | null> {
  const found = await profileByName(db, name);
  if (!found) return null;
  if (found.kind === "renamed") return { status: 301, body: "", location: `${origin}/u/${found.username}` };
  const { profile } = found;
  const names = await mentionNames(db, mentionIds(...profile.posts.map((post) => post.excerpt), ...profile.comments.map((comment) => comment.body)));
  const lines = [
    `# @${profile.username}`,
    "",
    `${profile.karma} karma · joined ${day(profile.joinedAt)}`,
    "",
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
      `- On [${linkText(comment.postTitle)}](${origin}${comment.postPath}#c-${comment.id}) · ${comment.score} points · ${day(comment.createdAt)}`,
      `  ${replaceMentions(comment.body, names)}`,
      "",
    );
  }
  return { status: 200, body: lines.join("\n") };
}

const NOT_FOUND = "# Not found\n\nNothing is at this address.\n";

/**
 * The page at a request's address as Markdown: the feed, a post with its
 * discussion, or a profile, as anyone signed out would see it. Null for
 * any other address, which is then served as usual.
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
  } else if (post) {
    const view = await postMarkdown(db, post[1]!, url.origin);
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
