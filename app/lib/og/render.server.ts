import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

// Binary modules must end in .bin to be bundled as data (see the Cloudflare
// Vite plugin's module rules). Inter is under the SIL Open Font License,
// beside them in OFL.txt; these are subset to Latin, Greek, and Cyrillic.
import regularFont from "./fonts/Inter-Regular.ttf.bin";
import semiboldFont from "./fonts/InterDisplay-SemiBold.ttf.bin";
import { type Cover, coverSvg, FAMILY, type Fonts } from "./cover";
import { readFontMetrics } from "./metrics";

// resvg is started once per isolate, on the first cover it draws, so no
// other request pays for it.
let started: Promise<void> | null = null;
let fonts: Fonts | null = null;

function start(): Promise<void> {
  started ??= initWasm(resvgWasm).catch((error: unknown) => {
    started = null;
    throw error;
  });
  return started;
}

function metrics(): Fonts {
  fonts ??= { regular: readFontMetrics(regularFont), semibold: readFontMetrics(semiboldFont) };
  return fonts;
}

/** A cover as PNG. */
export async function renderCover(cover: Cover): Promise<Uint8Array> {
  await start();
  const svg = coverSvg(cover, metrics());
  const resvg = new Resvg(svg, {
    font: {
      fontBuffers: [new Uint8Array(regularFont), new Uint8Array(semiboldFont)],
      loadSystemFonts: false,
      defaultFontFamily: FAMILY.regular,
    },
    textRendering: 1,
  });
  try {
    const image = resvg.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}

/** The picture types a cover can embed; WebP and others are left out. */
const EMBEDDABLE: Record<string, string> = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "image/gif": "image/gif",
};

/** Pictures larger than this are left out of covers, to keep rendering light. */
const PICTURE_MAX_BYTES = 3 * 1024 * 1024;

/** A stored picture as a data address a cover can show, or null if it cannot. */
export async function pictureFrom(bucket: R2Bucket, key: string | null | undefined): Promise<{ href: string } | null> {
  if (!key) return null;
  const object = await bucket.get(key);
  if (!object) return null;
  const type = EMBEDDABLE[object.httpMetadata?.contentType ?? ""];
  if (!type || object.size > PICTURE_MAX_BYTES) {
    await object.body.cancel();
    return null;
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { href: `data:${type};base64,${btoa(binary)}` };
}
