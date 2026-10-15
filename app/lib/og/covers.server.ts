import { generatedAvatar } from "../avatar";
import { AUTHOR_COLUMNS, AUTHOR_JOINS, toPublicAuthor } from "../db/rows.server";
import { mentionNames } from "../db/mentions.server";
import { formatMonthYear } from "../format";
import { displayHost } from "../links/url";
import { imageAddress } from "../media.server";
import { PAGES, type PageKey } from "../meta";
import { SITE_NAME, TAGLINE } from "../site";
import { plainText } from "../text/markdown";
import { mentionIds, replaceMentions } from "../text/mentions";
import type { Cover } from "./cover";
import { pictureFrom, renderCover } from "./render.server";
import { postCoverVersion, profileCoverVersion } from "./version";

/**
 * The covers a shared page shows, at /og/...: the site's, each standing
 * page's, each live post's, and each profile's. They hold only what the
 * page itself shows anyone, so they are the same for everyone and kept in
 * caches. A post's or profile's address carries a version of what it
 * shows, so an edit gets a new one.
 */

const PAGE = /^\/og\/page\/([a-z]+)\.png$/;
const POST = /^\/og\/p\/([A-Za-z0-9_-]{1,32})\.png$/;
const PROFILE = /^\/og\/u\/([a-z0-9_]{1,40})\.png$/;

const DAY = 24 * 3600;

function png(bytes: Uint8Array, maxAge: number): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": `public, max-age=${maxAge}`,
    },
  });
}

/** A cover found by its address: its current version, and how to draw it. */
interface Found {
  version: string;
  draw: () => Promise<Cover>;
}

/** Serves a drawn cover from the edge cache by its key, or draws and keeps it. */
export type Keep = (key: string, make: () => Promise<Response | null>) => Promise<Response | null>;

/**
 * The cover at this address, or null when there is none. The site's and
 * the standing pages' have one form only, so a query is ignored, and they
 * are kept by path. A post's or profile's is looked up live first, by its
 * key, and only then taken from the cache by its version: a post removed
 * or deleted, or a profile gone, has no cover from that moment, and an
 * edit sends old addresses to the new version.
 */
export async function coverResponse(url: URL, db: D1Database, bucket: R2Bucket, keep: Keep): Promise<Response | null> {
  if (url.pathname === "/og/site.png") {
    return keep(`${url.origin}${url.pathname}`, async () =>
      png(await renderCover({ kind: "site", tagline: TAGLINE.long, promise: TAGLINE.promise }), DAY),
    );
  }

  const page = PAGE.exec(url.pathname)?.[1];
  if (page !== undefined) {
    if (!(page in PAGES)) return null;
    const { title, description, path } = PAGES[page as PageKey];
    return keep(`${url.origin}${url.pathname}`, async () =>
      png(await renderCover({ kind: "page", title, description, address: `${url.host}${path}` }), DAY),
    );
  }

  const postId = POST.exec(url.pathname)?.[1];
  if (postId !== undefined) return versioned(url, await postCover(db, bucket, postId), keep);

  const name = PROFILE.exec(url.pathname)?.[1];
  if (name !== undefined) return versioned(url, await profileCover(db, bucket, name, url.host), keep);
  return null;
}

/**
 * A post's or profile's cover, drawn only at its current version. Any other
 * address, out of date or made up, is sent to the current one, so varying
 * the address never makes the board draw a cover.
 */
async function versioned(url: URL, found: Found | null, keep: Keep): Promise<Response | null> {
  if (!found) return null;
  if (url.searchParams.get("v") !== found.version || url.searchParams.size !== 1) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${url.pathname}?v=${found.version}`, "Cache-Control": "public, max-age=300" },
    });
  }
  return keep(`${url.origin}${url.pathname}?v=${encodeURIComponent(found.version)}`, async () =>
    png(await renderCover(await found.draw()), 7 * DAY),
  );
}

/** A live post's cover: its title, excerpt, and byline, with its picture beside them. */
async function postCover(db: D1Database, bucket: R2Bucket, id: string): Promise<Found | null> {
  const row = await db
    .prepare(
      `SELECT post.kind, post.title, post.description, post.origin, post.url, post.thumb_key,
              post.media_key, post.media_type, ${AUTHOR_COLUMNS}
       FROM posts AS post
       ${AUTHOR_JOINS("post")}
       WHERE post.id = ?1 AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL`,
    )
    .bind(id)
    .first<Parameters<typeof toPublicAuthor>[0] & {
      kind: "link" | "text" | "upload";
      title: string;
      description: string;
      origin: "made" | "found";
      url: string | null;
      thumb_key: string | null;
      media_key: string | null;
      media_type: string | null;
    }>();
  if (!row) return null;
  const author = toPublicAuthor(row);
  // An uploaded picture shows itself; anything else, its snapshot or poster.
  const pictureKey = row.kind === "upload" && row.media_type === "image" ? row.media_key : row.thumb_key;
  return {
    version: postCoverVersion({
      title: row.title,
      description: row.description,
      author: author.username,
      agent: author.agent === true,
      origin: row.origin,
      picture: pictureKey !== null,
    }),
    async draw() {
      const names = await mentionNames(db, mentionIds(row.description));
      const description = plainText(replaceMentions(row.description, names));
      const who = `${author.username}${author.agent ? " (agent)" : ""}`;
      const where = row.url ? ` · ${displayHost(new URL(row.url))}` : "";
      const byline =
        row.kind === "text" ? `Posted by ${who}` : `${row.origin === "made" ? "Made" : "Found"} by ${who}${where}`;
      const picture = await pictureFrom(bucket, pictureKey);
      return { kind: "post", title: row.title, description, byline, ...(picture ? { picture } : {}) };
    },
  };
}

/** A profile's cover: its name, picture, and who runs it, by any name it used. */
async function profileCover(db: D1Database, bucket: R2Bucket, name: string, host: string): Promise<Found | null> {
  const row = await db
    .prepare(
      `SELECT profile.user_id, profile.avatar_key, profile.owner_id, profile.created_at, current.name,
              owner_name.name AS owner_name
       FROM usernames AS asked
       JOIN profiles AS profile ON profile.user_id = asked.user_id AND profile.deleted_at IS NULL
       JOIN usernames AS current ON current.user_id = profile.user_id AND current.is_current = 1
       LEFT JOIN usernames AS owner_name ON owner_name.user_id = profile.owner_id AND owner_name.is_current = 1
       WHERE asked.name = ?1`,
    )
    .bind(name)
    .first<{
      user_id: string;
      avatar_key: string | null;
      owner_id: string | null;
      created_at: number;
      name: string;
      owner_name: string | null;
    }>();
  if (!row) return null;
  return {
    // As the profile page computes it, from the same name, owner, and picture.
    version: profileCoverVersion({
      username: row.name,
      owner: row.owner_name,
      photoUrl: row.avatar_key ? imageAddress(row.avatar_key) : undefined,
    }),
    async draw() {
      const subtitle = row.owner_id
        ? `An agent on ${SITE_NAME}, run by ${row.owner_name ?? "a member"}`
        : `On ${SITE_NAME} since ${formatMonthYear(row.created_at)}`;
      const picture = await pictureFrom(bucket, row.avatar_key);
      return {
        kind: "profile",
        name: row.name,
        subtitle,
        address: `${host}/u/${row.name}`,
        avatar: picture ?? generatedAvatar(row.user_id, row.name),
      };
    },
  };
}
