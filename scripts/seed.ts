/**
 * Prints SQL that fills a development or staging database with sample
 * content. Run it through `npm run db:seed:local` or `db:seed:staging`;
 * never against production.
 *
 * Everything here is invented or links to public pages. Each sample score is
 * backed by votes from sample voters, accounts with no name that never post,
 * and karma is computed from those votes the way the board computes it, so
 * a real vote on a sample post moves its score by one.
 */
import { karmaSql } from "../app/lib/db/votes.server";
import { resolveLink } from "../app/lib/links/resolve";
import { parseSubmittedUrl } from "../app/lib/links/url";

const now = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const DAY = 24 * HOUR;

const users = [
  "quiet_otter_482",
  "paper_lark_17",
  "amber_moth_905",
  "tidal_wren_63",
  "slow_comet_240",
  "glass_heron_71",
  "north_finch_388",
  "velvet_newt_12",
].map((username, index) => ({
  id: `s_user_${String(index + 1).padStart(2, "0")}`,
  username,
}));

interface SeedPost {
  url: string;
  origin: "made" | "found";
  title: string;
  description: string;
  /** Age in hours. */
  age: number;
  score: number;
  author: number;
  pageTitle?: string;
  state?: "removed" | "deleted";
}

const posts: SeedPost[] = [
  {
    url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
    origin: "found",
    title: "Sample post: Big Buck Bunny, an open movie on YouTube",
    description:
      "A widescreen video from YouTube. Tap the poster to load the player. This is sample content for testing the feed.",
    age: 3,
    score: 128,
    author: 0,
  },
  {
    url: "https://www.tiktok.com/@scout2015/video/6718335390845095173",
    origin: "found",
    title: "Sample post: a vertical video from TikTok",
    description:
      "Vertical video is shown at its own width, centered, with nothing boxed around it.",
    age: 5,
    score: 57,
    author: 1,
  },
  {
    url: "https://suno.com/song/cf674415-debb-498c-aa29-37a58a28d8e9",
    origin: "found",
    title: "Sample post: a generated song on Suno",
    description:
      "Songs never start by themselves. The player follows the site theme.",
    age: 9,
    score: 41,
    author: 2,
  },
  {
    url: "https://x.com/jack/status/20",
    origin: "found",
    title: "Sample post: a post on X",
    description: "Posts from X load on click, in the site theme.",
    age: 14,
    score: 12,
    author: 3,
  },
  {
    url: "https://www.reddit.com/r/place/comments/tqbguc/412022/",
    origin: "found",
    title: "Sample post: a Reddit post in its compact layout",
    description:
      "Reddit posts use the compact layout and take the height the embed reports.",
    age: 20,
    score: 19,
    author: 2,
  },
  {
    url: "https://t.me/telegram/83",
    origin: "found",
    title: "Sample post: a Telegram channel post",
    description:
      "Public channel posts embed as one bubble. On a narrow phone the frame is scaled to fit.",
    age: 26,
    score: 9,
    author: 4,
  },
  {
    url: "https://github.com/chatcode-lab/aionly",
    origin: "made",
    title: "The source for this board, built in Chatcode Lab sessions",
    description:
      "Everything here was written in AI coding sessions and is public: the plan, the code, and the tests.",
    age: 30,
    score: 203,
    author: 0,
    pageTitle: "chatcode-lab/aionly",
  },
  {
    url: "https://arxiv.org/abs/1706.03762",
    origin: "found",
    title: "Attention Is All You Need (the 2017 transformer paper)",
    description:
      "Related reading rather than something made with AI. The board accepts both, and favors the made.",
    age: 40,
    score: 88,
    author: 5,
    pageTitle: "Attention Is All You Need",
  },
  {
    url: "https://www.youtube.com/watch?v=eRsGyueVLvQ",
    origin: "found",
    title: "Sample post: Sintel, a second open movie",
    description: "Another widescreen sample, a few days old.",
    age: 3 * 24,
    score: 64,
    author: 1,
  },
  {
    url: "https://example.com/roguelike",
    origin: "made",
    title:
      "Sample post with a deliberately long title, to check how a headline wraps across several lines on a narrow phone",
    description:
      "A link to an ordinary page becomes a preview card. This one has no image, so the card is the title and domain.",
    age: 4 * 24,
    score: 31,
    author: 3,
    pageTitle: "Example Domain",
  },
  {
    url: "https://www.youtube.com/watch?v=R6MlUcmOul8",
    origin: "found",
    title: "Sample post: Tears of Steel, a third open movie",
    description: "Still inside the past week.",
    age: 5 * 24,
    score: 22,
    author: 4,
  },
  {
    url: "https://example.org/narrator",
    origin: "found",
    title: "Sample post: a plain link with a negative score",
    description: "Downvoted below zero, to show how that reads in the feed.",
    age: 6 * 24,
    score: -3,
    author: 7,
  },
  {
    url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    origin: "found",
    title: "Sample post: Me at the zoo, the first YouTube video",
    description: "Older than a week, so it only appears under Month and All time.",
    age: 12 * 24,
    score: 240,
    author: 5,
  },
  {
    url: "https://example.com/gallery",
    origin: "made",
    title: "Sample post: a gallery page from two weeks ago",
    description: "A page link from earlier in the month.",
    age: 15 * 24,
    score: 17,
    author: 6,
  },
  {
    url: "https://example.org/tool",
    origin: "made",
    title: "Sample post: a small tool, three weeks old",
    description: "Another page link, for the Month range.",
    age: 21 * 24,
    score: 45,
    author: 2,
  },
  {
    url: "https://example.com/archive",
    origin: "found",
    title: "Sample post: something from two months ago",
    description: "Old enough to appear only under All time.",
    age: 60 * 24,
    score: 310,
    author: 1,
  },
  {
    url: "https://example.org/removed",
    origin: "found",
    title: "Removed sample (this title must never be shown)",
    description: "Removed sample description (must never be shown).",
    age: 30,
    score: 4,
    author: 7,
    state: "removed",
  },
  {
    url: "https://example.org/deleted",
    origin: "made",
    title: "Deleted sample (this title must never be shown)",
    description: "Deleted sample description (must never be shown).",
    age: 34,
    score: 2,
    author: 6,
    state: "deleted",
  },
];

// Enough older posts that All time runs to a second page.
for (let n = 1; n <= 10; n += 1) {
  posts.push({
    url: `https://example.com/archive/${n}`,
    origin: n % 2 === 0 ? "made" : "found",
    title: `Sample post: archive item ${n}`,
    description: "An older sample post, here so that Load more has something to load.",
    age: (34 + 2 * n) * 24,
    score: 30 - n,
    author: n % 8,
  });
}

interface SeedComment {
  author: number;
  /** Minutes after the post. */
  after: number;
  score: number;
  body: string;
  state?: "removed" | "deleted";
  edited?: boolean;
  replies?: SeedComment[];
}

// Threads for the first and seventh posts.
const threads: Record<number, SeedComment[]> = {
  0: [
    {
      author: 1,
      after: 12,
      score: 34,
      body: "Sample comment. The first reply on a thread, with a few replies under it.",
      replies: [
        {
          author: 2,
          after: 20,
          score: 9,
          body: "A reply, one level down.",
          edited: true,
          replies: [
            {
              author: 0,
              after: 28,
              score: 12,
              body: "Two levels down.",
              replies: [
                {
                  author: 3,
                  after: 40,
                  score: 3,
                  body: "Three levels down.",
                  replies: [
                    {
                      author: 4,
                      after: 55,
                      score: 1,
                      body: "Four levels down. On a phone the indentation has stopped growing by now, but the reply keeps its place in the thread.",
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          author: 7,
          after: 33,
          score: -7,
          body: "A sample comment at minus seven. Its text starts hidden, and anyone can choose to read it.",
        },
      ],
    },
    {
      author: 5,
      after: 44,
      score: 2,
      body: "Removed sample comment (this text must never be shown).",
      state: "removed",
      replies: [
        {
          author: 2,
          after: 61,
          score: 4,
          body: "A reply to a removed comment stays where it was.",
        },
      ],
    },
    {
      author: 6,
      after: 70,
      score: 1,
      body: "Deleted sample comment (this text must never be shown).",
      state: "deleted",
    },
    {
      author: 3,
      after: 95,
      score: 6,
      body: "A second top-level comment.\n\nIt has two paragraphs, to check spacing.",
    },
  ],
  6: [
    {
      author: 4,
      after: 30,
      score: 15,
      body: "Is the plan in the repository too?",
      replies: [
        {
          author: 0,
          after: 42,
          score: 11,
          body: "Yes, under docs. It is the first file to read.",
        },
      ],
    },
    { author: 5, after: 90, score: 5, body: "Bookmarked." },
  ],
};

// ---- SQL

const q = (value: string | number | null | undefined): string =>
  value === null || value === undefined
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${value.replaceAll("'", "''")}'`;

const lines: string[] = [];
const insert = (table: string, row: Record<string, string | number | null | undefined>) => {
  const columns = Object.keys(row);
  lines.push(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((column) => q(row[column])).join(", ")});`,
  );
};

// Clear earlier sample rows, children first: the rows this script made, and
// whatever real accounts attached to them since, such as votes and saves.
for (const [table, ...columns] of [
  ["pins", "post_id"],
  ["reports", "target_id"],
  ["mod_actions", "id"],
  ["bookmarks", "user_id", "post_id"],
  ["votes", "voter_id", "target_id"],
  ["comments", "id", "post_id"],
  ["posts", "id"],
  ["usernames", "user_id"],
  ["profiles", "user_id"],
] as const) {
  const sample = columns.map((column) => `${column} LIKE 's\\_%' ESCAPE '\\'`);
  lines.push(`DELETE FROM ${table} WHERE ${sample.join(" OR ")};`);
}
// Mentions in or of the sample rows just cleared.
lines.push(`DELETE FROM mentions WHERE target_id LIKE 's\\_%' ESCAPE '\\' OR item_id LIKE 's\\_%' ESCAPE '\\';`);

for (const user of users) {
  insert("profiles", { user_id: user.id, created_at: now - 90 * DAY });
  insert("usernames", { name: user.username, user_id: user.id, is_current: 1, created_at: now - 90 * DAY });
}
// One renamed account, to exercise the redirect from an old name.
insert("usernames", { name: "old_otter_name", user_id: users[0].id, is_current: 0, created_at: now - 120 * DAY });
// A moderator, to own the sample removals.
insert("profiles", { user_id: "s_user_mod", role: "admin", created_at: now - 90 * DAY });
insert("usernames", { name: "sample_moderator", user_id: "s_user_mod", is_current: 1, created_at: now - 90 * DAY });

/** Every sample item with a score, to back with votes at the end. */
const scored: Array<{ type: "post" | "comment"; id: string; score: number }> = [];

let commentNumber = 0;
const countComments = (comments: SeedComment[]): number =>
  comments.reduce((total, comment) => total + 1 + countComments(comment.replies ?? []), 0);

posts.forEach((post, index) => {
  const parsed = parseSubmittedUrl(post.url);
  if (!parsed.ok) throw new Error(`seed URL rejected: ${post.url} (${parsed.reason})`);
  const link = resolveLink(parsed.url);
  if (link.kind === "short") throw new Error(`seed URL is a short link: ${post.url}`);

  const id = `s_post_${String(index + 1).padStart(2, "0")}`;
  const createdAt = now - post.age * HOUR;
  const thread = threads[index] ?? [];
  const batch = post.state === "removed" ? `s_batch_post_${index + 1}` : null;

  scored.push({ type: "post", id, score: post.score });
  insert("posts", {
    id,
    author_id: users[post.author].id,
    url: post.url,
    canonical_key: link.canonicalKey,
    provider: link.kind === "media" ? link.provider : null,
    origin: post.origin,
    title: post.title,
    description: post.description,
    page_title: post.pageTitle,
    aspect: link.kind === "media" ? link.aspect : null,
    score: post.score,
    comment_count: countComments(thread),
    created_at: createdAt,
    deleted_at: post.state === "deleted" ? createdAt + HOUR : null,
    removed_batch_id: batch,
  });
  if (batch) {
    insert("mod_actions", {
      id: `s_action_post_${index + 1}`,
      batch_id: batch,
      actor_id: "s_user_mod",
      action: "remove_post",
      target_type: "post",
      target_id: id,
      reason: "Sample removal",
      created_at: createdAt + HOUR,
    });
  }

  const walk = (comments: SeedComment[], parentId: string | null, depth: number) => {
    for (const comment of comments) {
      commentNumber += 1;
      const commentId = `s_comment_${String(commentNumber).padStart(3, "0")}`;
      const at = createdAt + comment.after * 60;
      const commentBatch = comment.state === "removed" ? `s_batch_comment_${commentNumber}` : null;
      scored.push({ type: "comment", id: commentId, score: comment.score });
      insert("comments", {
        id: commentId,
        post_id: id,
        parent_id: parentId,
        author_id: users[comment.author].id,
        body: comment.body,
        depth,
        score: comment.score,
        created_at: at,
        edited_at: comment.edited ? at + 20 * 60 : null,
        deleted_at: comment.state === "deleted" ? at + 30 * 60 : null,
        removed_batch_id: commentBatch,
      });
      if (commentBatch) {
        insert("mod_actions", {
          id: `s_action_comment_${commentNumber}`,
          batch_id: commentBatch,
          actor_id: "s_user_mod",
          action: "remove_comment",
          target_type: "comment",
          target_id: commentId,
          reason: "Sample removal",
          created_at: at + 30 * 60,
        });
      }
      walk(comment.replies ?? [], commentId, depth + 1);
    }
  };
  walk(thread, null, 0);
});

// Sample voters: enough that the highest score has one vote per voter.
const voterCount = Math.max(...scored.map((item) => Math.abs(item.score)));
const voter = (n: number) => `s_voter_${String(n).padStart(3, "0")}`;
for (let n = 1; n <= voterCount; n += 1) {
  insert("profiles", { user_id: voter(n), created_at: now - 120 * DAY });
}
for (const item of scored) {
  for (let n = 1; n <= Math.abs(item.score); n += 1) {
    insert("votes", {
      voter_id: voter(n),
      target_type: item.type,
      target_id: item.id,
      value: Math.sign(item.score),
      created_at: now - 30 * DAY,
    });
  }
}
lines.push(
  `UPDATE profiles SET karma = ${karmaSql("profiles.user_id").replace(/\s+/g, " ")} WHERE user_id LIKE 's\\_user\\_%' ESCAPE '\\';`,
);

console.log(lines.join("\n"));
