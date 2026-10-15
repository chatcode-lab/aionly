import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Drawing needs WebAssembly the test runtime cannot load; versions do not.
vi.mock("../../app/lib/og/render.server", () => ({
  renderCover: async () => new Uint8Array(),
  pictureFrom: async () => null,
}));

import { purgePostMedia } from "../../app/lib/db/moderation.server";
import { coverResponse } from "../../app/lib/og/covers.server";
import { db, NOW, post, reset, user } from "./fixtures";

/** Serves from a pretend edge cache: what it would hold, without drawing. */
const keep = async (key: string) => new Response(`cached ${key}`);

const cover = (path: string) => coverResponse(new URL(`https://board.test${path}`), db, env.IMAGES, keep);

beforeEach(async () => {
  await reset();
  await user("u1", "quiet_otter");
  await user("admin", "the_admin", { role: "admin" });
});

describe("post covers", () => {
  it("change version when a restored post's files were deleted, so the cached copy with its picture is never served", async () => {
    await post("p1", { author: "u1" });
    const thumb = "p1thumbxxxxxxxxxxxxxxxxx.jpg";
    await db.batch([
      db.prepare(`UPDATE posts SET thumb_key = ?1 WHERE id = 'p1'`).bind(thumb),
      db.prepare(`INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at) VALUES (?1, 'u1', 'post', 'attached', 'image/jpeg', 3, ?2)`).bind(thumb, NOW),
    ]);
    await env.IMAGES.put(thumb, "jpg");

    const first = await cover("/og/p/p1.png?v=x");
    const withPicture = new URL(first!.headers.get("Location")!, "https://board.test").searchParams.get("v")!;
    expect(await (await cover(`/og/p/p1.png?v=${withPicture}`))!.text()).toBe(`cached https://board.test/og/p/p1.png?v=${withPicture}`);

    // Removed: no cover at all, cached or not.
    await db.prepare(`UPDATE posts SET removed_batch_id = 'b1' WHERE id = 'p1'`).run();
    expect(await cover(`/og/p/p1.png?v=${withPicture}`)).toBeNull();

    // Its files deleted, then restored: the old version only redirects.
    await purgePostMedia(db, env.IMAGES, { postId: "p1", actorId: "admin", now: NOW });
    await db.prepare(`UPDATE posts SET removed_batch_id = NULL WHERE id = 'p1'`).run();
    const after = await cover(`/og/p/p1.png?v=${withPicture}`);
    expect(after!.status).toBe(302);
    expect(after!.headers.get("Location")).not.toContain(withPicture);
  });
});
