import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { pngOf } from "../../app/lib/og/png.server";
import { pictureSize } from "../../app/lib/uploads";
import { BIG_PNG, WIDE_PNG } from "./pictures";

const webpOf = async (bytes: Uint8Array<ArrayBuffer>) => {
  const result = await env.IMAGING.input(new Response(bytes).body!).output({ format: "image/webp", quality: 85 });
  return new Uint8Array(await new Response(result.image()).arrayBuffer());
};

/** A PNG's color type, from its header: 6 is color with transparency. */
const colorType = (png: Uint8Array) => png[25];

// A digest's first post showed no picture when its link's snapshot was WebP,
// which resvg cannot read, so framing it found nothing (owner's report, 2026-11-16).
describe("a WebP post picture, drawn for a cover or a digest", () => {
  it("becomes a PNG of its own size, its transparency kept", async () => {
    const webp = await webpOf(new Uint8Array(WIDE_PNG));
    expect(pictureSize(webp)).toMatchObject({ width: 30, height: 20 });
    const png = (await pngOf(env.IMAGING, webp, 800))!;
    expect(pictureSize(png)).toMatchObject({ width: 30, height: 20 });
    expect(colorType(png)).toBe(6);
  });

  it("comes no larger than it is drawn at, in its own shape", async () => {
    const png = (await pngOf(env.IMAGING, await webpOf(new Uint8Array(BIG_PNG)), 100))!;
    expect(pictureSize(png)).toMatchObject({ width: 100, height: 80 });
  });

  it("is none when the binding cannot read it", async () => {
    expect(await pngOf(env.IMAGING, new TextEncoder().encode("not a picture"), 800)).toBeNull();
  });
});
