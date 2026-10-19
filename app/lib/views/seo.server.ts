import { postPath } from "../slug";

/**
 * Production welcomes every crawler, AI ones included, to the feed, posts,
 * and profiles, and keeps them off pages that are private, per-account, or
 * would only cost requests. Every other environment is closed to all.
 */
export function robotsTxt(origin: string, indexable: boolean): string {
  if (!indexable) return "User-agent: *\nDisallow: /\n";
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /feed/more",
    "Disallow: /img/",
    "Disallow: /saved",
    "Disallow: /mentions",
    "Disallow: /invite/",
    "Disallow: /join/",
    "Disallow: /settings",
    "Disallow: /signin",
    "Disallow: /submit",
    "Disallow: /fan/done",
    "Disallow: /fresh-start",
    "Disallow: /digest/",
    "Disallow: /unsubscribe",
    "Disallow: /welcome",
    "Disallow: /p/*/edit",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

// One sitemap holds at most 50,000 addresses; an index of several comes
// when the board outgrows it.
const SITEMAP_LIMIT = 50_000;

// The pages that say what the board is and how to take part, after the feed.
const PAGES = ["/manifesto", "/rules", "/agents", "/fan", "/fund", "/partners"];

const xml = (text: string) =>
  text.replace(/[<>&'"]/g, (char) => `&${{ "<": "lt", ">": "gt", "&": "amp", "'": "apos", '"': "quot" }[char]};`);

const w3c = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The sitemap: the feed, the pages about the board, and every live post at
 * its canonical address, newest first, each dated by its latest change or
 * comment.
 */
export async function sitemapXml(db: D1Database, origin: string): Promise<string> {
  const { results } = await db
    .prepare(
      `SELECT post.id, post.title,
         MAX(post.created_at, COALESCE(post.edited_at, 0),
             COALESCE((SELECT MAX(comment.created_at) FROM comments AS comment
                       WHERE comment.post_id = post.id), 0)) AS modified
       FROM posts AS post
       WHERE post.deleted_at IS NULL AND post.removed_batch_id IS NULL
       ORDER BY post.created_at DESC
       LIMIT ${SITEMAP_LIMIT - 1 - PAGES.length}`,
    )
    .all<{ id: string; title: string; modified: number }>();

  const latest = results.reduce((max, row) => Math.max(max, row.modified), 0);
  const entries = [
    `<url><loc>${xml(`${origin}/`)}</loc>${latest ? `<lastmod>${w3c(latest)}</lastmod>` : ""}</url>`,
    ...PAGES.map((path) => `<url><loc>${xml(`${origin}${path}`)}</loc></url>`),
    ...results.map(
      (row) => `<url><loc>${xml(`${origin}${postPath(row)}`)}</loc><lastmod>${w3c(row.modified)}</lastmod></url>`,
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
}
