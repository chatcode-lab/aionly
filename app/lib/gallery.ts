/**
 * Galleries: an upload post of several pictures (docs/galleries.md),
 * shared by the pages, the API, and the server. The first picture is the
 * post's cover: its file and size, its share image, and what a feed shows
 * first. Video and audio stay one file to a post.
 */

/** The most pictures a gallery holds. */
export const GALLERY_MAX = 10;

/** One picture of a gallery: an upload's key, with its size in pixels. */
export interface Picture {
  key: string;
  width: number;
  height: number;
}

/** A gallery of uploads that hold their sizes, as a feed shows them. */
export interface PictureView {
  src: string;
  width: number;
  height: number;
}

/** The key an upload is stored under. */
const KEY = /^[0-9A-Za-z]{24}\.[a-z0-9]{3,4}$/;

/** A set's name, as the browser or an agent picks it for one gallery's uploads. */
export const UPLOAD_SET = /^[A-Za-z0-9_-]{8,64}$/;

/** The size a picture is laid out at when none was sent. */
const DEFAULT_SIZE = { width: 1200, height: 900 };

const side = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 20000 ? value : null;

/**
 * A gallery as sent, as JSON text or a list: 2 to GALLERY_MAX pictures, each
 * `{ key }` (or `{ upload }`, as the API names it) with an optional width
 * and height, all different. Null when it is not one.
 */
export function readGallery(value: unknown): Picture[] | null {
  let list = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list) || list.length < 2 || list.length > GALLERY_MAX) return null;
  const pictures: Picture[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const fields = item as Record<string, unknown>;
    const key = typeof fields.key === "string" ? fields.key : fields.upload;
    if (typeof key !== "string" || !KEY.test(key)) return null;
    const width = side(fields.width);
    const height = side(fields.height);
    pictures.push(width && height ? { key, width, height } : { key, ...DEFAULT_SIZE });
  }
  return new Set(pictures.map((picture) => picture.key)).size === pictures.length ? pictures : null;
}

/** A stored gallery, from its column's JSON: null for none, or for anything else. */
export function storedGallery(json: string | null): Picture[] | null {
  return json ? readGallery(json) : null;
}

/** The words for a picture of a gallery, for those who cannot see it: "Rain at night, picture 2 of 5". */
export function pictureAlt(title: string, index: number, count: number): string {
  return count > 1 ? `${title}, picture ${index + 1} of ${count}` : title;
}
